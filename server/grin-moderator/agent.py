import asyncio
import io
import json
import logging
import os
import re
import time
import urllib.request
import uuid

import boto3
from livekit import rtc
from livekit.agents import AgentServer, AutoSubscribe, JobContext, cli, stt
from livekit.plugins import aws
from PIL import Image

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("grin-moderator")

AWS_REGION = os.environ.get("AWS_REGION", "").strip()
TRANSCRIBE_LANGUAGE = os.environ.get("GRIN_TRANSCRIBE_LANGUAGE", "fr-FR").strip()
EVENT_URL = os.environ.get("GRIN_MODERATION_EVENT_URL", "").strip()
EVENT_SECRET = os.environ.get("GRIN_MODERATION_WEBHOOK_SECRET", "").strip()
FRAME_INTERVAL_SECONDS = 5
FRAME_MIN_CONFIDENCE = 70
EVENT_COOLDOWN_SECONDS = 60

THREAT_PATTERNS = (
    re.compile(r"\bje vais te tuer\b"),
    re.compile(r"\bje vais vous tuer\b"),
    re.compile(r"\bje vais te frapper\b"),
    re.compile(r"\bje vais vous frapper\b"),
    re.compile(r"\bje vais te faire du mal\b"),
    re.compile(r"\bje vais vous faire du mal\b"),
)
INSULT_PATTERN = re.compile(
    r"\b(connard|connasse|salaud|salope|idiot|idiote|imbécile)\b",
    re.IGNORECASE,
)

server = AgentServer()
rekognition = boto3.client("rekognition", region_name=AWS_REGION) if AWS_REGION else None
last_reported: dict[tuple[str, str], float] = {}


def frame_as_jpeg(frame: rtc.VideoFrame) -> bytes:
    rgb = frame.convert(rtc.VideoBufferType.RGB24)
    image = Image.frombytes("RGB", (rgb.width, rgb.height), bytes(rgb.data))
    image.thumbnail((640, 640))
    output = io.BytesIO()
    image.save(output, format="JPEG", quality=60, optimize=True)
    return output.getvalue()


def analyze_frame(frame_bytes: bytes) -> list[tuple[str, float]]:
    if rekognition is None:
        raise RuntimeError("AWS_REGION is required by the Grin moderation agent.")
    response = rekognition.detect_moderation_labels(
        Image={"Bytes": frame_bytes},
        MinConfidence=FRAME_MIN_CONFIDENCE,
        MaxLabels=20,
    )
    return [
        (label["Name"], float(label["Confidence"]))
        for label in response.get("ModerationLabels", [])
    ]


def submit_event(
    participant_id: str,
    track_sid: str,
    media_type: str,
    category: str,
    confidence: float,
) -> dict:
    if not EVENT_URL or len(EVENT_SECRET) < 32:
        raise RuntimeError("Moderation event URL or shared secret is missing.")
    body = json.dumps(
        {
            "id": str(uuid.uuid4()),
            "roomName": "grin",
            "participantId": participant_id,
            "trackSid": track_sid,
            "mediaType": media_type,
            "category": category,
            "confidence": round(confidence, 2),
        }
    ).encode()
    request = urllib.request.Request(
        EVENT_URL,
        data=body,
        headers={
            "Content-Type": "application/json",
            "X-Grin-Moderation-Token": EVENT_SECRET,
        },
        method="POST",
    )
    with urllib.request.urlopen(request, timeout=8) as response:
        return json.loads(response.read())


async def report_once(
    participant_id: str,
    track_sid: str,
    media_type: str,
    category: str,
    confidence: float,
) -> None:
    now = time.monotonic()
    key = (participant_id, f"{media_type}:{category}")
    if now - last_reported.get(key, 0) < EVENT_COOLDOWN_SECONDS:
        return
    try:
        result = await asyncio.to_thread(
            submit_event,
            participant_id,
            track_sid,
            media_type,
            category,
            confidence,
        )
    except Exception:
        logger.exception("Unable to submit a Grin moderation event.")
        return
    last_reported[key] = now
    logger.info(
        "Moderation event accepted: id=%s media=%s category=%s status=%s",
        result.get("eventId"),
        media_type,
        category,
        result.get("status"),
    )


async def monitor_video(
    track: rtc.RemoteVideoTrack,
    participant_id: str,
    track_sid: str,
) -> None:
    stream = rtc.VideoStream(track)
    last_sample = 0.0
    async for event in stream:
        now = time.monotonic()
        if now - last_sample < FRAME_INTERVAL_SECONDS:
            continue
        last_sample = now
        try:
            image_bytes = await asyncio.to_thread(frame_as_jpeg, event.frame)
            labels = await asyncio.to_thread(analyze_frame, image_bytes)
        except Exception:
            logger.exception("Unable to process an AWS Rekognition video sample.")
            continue
        for category, confidence in labels:
            if confidence >= FRAME_MIN_CONFIDENCE:
                await report_once(
                    participant_id,
                    track_sid,
                    "VIDEO",
                    category,
                    confidence,
                )
    await stream.aclose()


async def monitor_audio(
    track: rtc.RemoteAudioTrack,
    participant_id: str,
    track_sid: str,
) -> None:
    speech_stream = aws.STT(
        region=AWS_REGION,
        language=TRANSCRIBE_LANGUAGE,
        sample_rate=16000,
    ).stream()
    audio_stream = rtc.AudioStream(track, sample_rate=16000, num_channels=1)

    async def consume_transcripts() -> None:
        async for event in speech_stream:
            if event.type != stt.SpeechEventType.FINAL_TRANSCRIPT:
                continue
            text = " ".join(
                alternative.text
                for alternative in event.alternatives
                if alternative.text
            ).casefold()
            if any(pattern.search(text) for pattern in THREAT_PATTERNS):
                await report_once(
                    participant_id,
                    track_sid,
                    "AUDIO",
                    "Threat",
                    85,
                )
            elif INSULT_PATTERN.search(text):
                await report_once(
                    participant_id,
                    track_sid,
                    "AUDIO",
                    "Insult",
                    80,
                )

    transcript_task = asyncio.create_task(consume_transcripts())
    try:
        async for event in audio_stream:
            speech_stream.push_frame(event.frame)
    finally:
        await audio_stream.aclose()
        await speech_stream.aclose()
        await transcript_task


def subscribe_to_consented_tracks(
    participant: rtc.RemoteParticipant,
) -> None:
    if participant.attributes.get("grin_moderation_consent") != "true":
        return
    for publication in participant.track_publications.values():
        if publication.kind not in (
            rtc.TrackKind.KIND_AUDIO,
            rtc.TrackKind.KIND_VIDEO,
        ):
            continue
        publication.set_subscribed(True)


@server.rtc_session(agent_name="grin-moderator")
async def moderate_grin(ctx: JobContext) -> None:
    if not AWS_REGION or not EVENT_URL or len(EVENT_SECRET) < 32:
        raise RuntimeError("Grin moderation agent configuration is incomplete.")

    jobs: set[asyncio.Task] = set()

    def track_subscribed(
        track: rtc.Track,
        publication: rtc.RemoteTrackPublication,
        participant: rtc.RemoteParticipant,
    ) -> None:
        if participant.attributes.get("grin_moderation_consent") != "true":
            return
        if track.kind == rtc.TrackKind.KIND_VIDEO:
            task = asyncio.create_task(
                monitor_video(track, participant.identity, publication.sid)
            )
        elif track.kind == rtc.TrackKind.KIND_AUDIO:
            task = asyncio.create_task(
                monitor_audio(track, participant.identity, publication.sid)
            )
        else:
            return
        jobs.add(task)

        def finish_task(finished: asyncio.Task) -> None:
            jobs.discard(finished)
            if finished.cancelled():
                return
            error = finished.exception()
            if error is not None:
                logger.error(
                    "Grin track monitor stopped unexpectedly.",
                    exc_info=(type(error), error, error.__traceback__),
                )

        task.add_done_callback(finish_task)

    @ctx.room.on("track_subscribed")
    def on_track_subscribed(
        track: rtc.Track,
        publication: rtc.RemoteTrackPublication,
        participant: rtc.RemoteParticipant,
    ) -> None:
        track_subscribed(track, publication, participant)

    @ctx.room.on("participant_connected")
    def on_participant_connected(participant: rtc.RemoteParticipant) -> None:
        subscribe_to_consented_tracks(participant)

    @ctx.room.on("track_published")
    def on_track_published(
        publication: rtc.RemoteTrackPublication,
        participant: rtc.RemoteParticipant,
    ) -> None:
        if participant.attributes.get("grin_moderation_consent") == "true":
            publication.set_subscribed(True)

    await ctx.connect(auto_subscribe=AutoSubscribe.SUBSCRIBE_NONE)
    for participant in ctx.room.remote_participants.values():
        subscribe_to_consented_tracks(participant)

    try:
        await ctx.wait_for_shutdown()
    finally:
        for job in jobs:
            job.cancel()
        if jobs:
            await asyncio.gather(*jobs, return_exceptions=True)


if __name__ == "__main__":
    cli.run_app(server)
