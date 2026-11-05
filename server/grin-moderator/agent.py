import asyncio
import hmac
import io
import json
import logging
import math
import os
import re
import threading
import time
import unicodedata
import urllib.parse
import urllib.request
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from livekit import rtc
from livekit.agents import AgentServer, AutoSubscribe, JobContext, cli, stt
from PIL import Image

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("grin-moderator")

AWS_REGION = os.environ.get("AWS_REGION", "").strip()
AWS_REKOGNITION_ENABLED = (
    os.environ.get("AWS_REKOGNITION_ENABLED", "").strip().lower() == "true"
)
AWS_TRANSCRIBE_ENABLED = (
    os.environ.get("AWS_TRANSCRIBE_ENABLED", "").strip().lower() == "true"
)
UPLOAD_MODERATION_ENABLED = (
    os.environ.get("MODERATION_UPLOADS_WORKER_ENABLED", "").strip().lower()
    == "true"
    and AWS_REKOGNITION_ENABLED
)
TEXT_MODERATION_ENABLED = (
    os.environ.get("TEXT_MODERATION_ENABLED", "").strip().lower() == "true"
    and AWS_TRANSCRIBE_ENABLED
)
UPLOAD_MODERATION_SECRET = os.environ.get(
    "GRIN_MODERATION_WEBHOOK_SECRET", ""
).strip()
UPLOAD_MODERATION_HTTP_PORT = int(
    os.environ.get("MODERATION_HTTP_PORT", "8081").strip()
)
CLOUDINARY_CLOUD_NAME = os.environ.get("CLOUDINARY_CLOUD_NAME", "").strip()
TRANSCRIBE_LANGUAGE = os.environ.get("GRIN_TRANSCRIBE_LANGUAGE", "fr-FR").strip()
EVENT_URL = os.environ.get("GRIN_MODERATION_EVENT_URL", "").strip()
EVENT_SECRET = os.environ.get("GRIN_MODERATION_WEBHOOK_SECRET", "").strip()
FRAME_INTERVAL_SECONDS = 5
FRAME_MIN_CONFIDENCE = 70
EVENT_COOLDOWN_SECONDS = 60

server = AgentServer()
if AWS_REKOGNITION_ENABLED:
    import boto3

    rekognition = boto3.client("rekognition", region_name=AWS_REGION)
else:
    rekognition = None
last_reported: dict[tuple[str, str], float] = {}
lexicon_cache: list[dict] = []
lexicon_cache_updated = 0.0
lexicon_cache_lock = threading.Lock()


def moderation_lexicon_url() -> str:
    parsed = urllib.parse.urlsplit(EVENT_URL)
    if not parsed.scheme or not parsed.netloc:
        raise ValueError("GRIN_MODERATION_EVENT_URL must be configured for text moderation.")
    path = parsed.path.rsplit("/", 1)[0] + "/lexicon"
    return urllib.parse.urlunsplit((parsed.scheme, parsed.netloc, path, "", ""))


def fetch_moderation_lexicon() -> list[dict]:
    request = urllib.request.Request(
        moderation_lexicon_url(),
        headers={"x-grin-moderation-token": EVENT_SECRET},
    )
    with urllib.request.urlopen(request, timeout=5) as response:
        payload = json.loads(response.read(256 * 1024))
    entries = payload.get("entries")
    if not isinstance(entries, list):
        raise ValueError("The moderation lexicon response is invalid.")
    return [
        entry
        for entry in entries
        if isinstance(entry, dict)
        and isinstance(entry.get("term"), str)
        and entry.get("category") in ("INSULT", "THREAT")
    ]


def get_moderation_lexicon() -> list[dict]:
    global lexicon_cache, lexicon_cache_updated
    with lexicon_cache_lock:
        if time.monotonic() - lexicon_cache_updated < 60:
            return lexicon_cache
        lexicon_cache = fetch_moderation_lexicon()
        lexicon_cache_updated = time.monotonic()
        return lexicon_cache


def normalize_text(value: str) -> str:
    decomposed = unicodedata.normalize("NFD", value.casefold())
    return "".join(character for character in decomposed if not unicodedata.combining(character))


def text_category(text: str, entries: list[dict]) -> str | None:
    normalized_text = normalize_text(text)
    for entry in entries:
        term = normalize_text(entry["term"]).strip()
        phrase = r"\s+".join(re.escape(part) for part in term.split())
        if re.search(rf"(?<!\w){phrase}(?!\w)", normalized_text, re.UNICODE):
            return entry["category"]
    return None


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


def cloudinary_sample_url(url: str, media_type: str, second: float = 0) -> str:
    parsed = urllib.parse.urlsplit(url)
    if (
        parsed.scheme != "https"
        or parsed.hostname != "res.cloudinary.com"
        or not CLOUDINARY_CLOUD_NAME
        or f"/{CLOUDINARY_CLOUD_NAME}/" not in parsed.path
    ):
        raise ValueError("Upload URL is not a configured Cloudinary asset.")
    if media_type == "image" and "/image/upload/" in parsed.path:
        path = parsed.path.replace(
            "/image/upload/",
            "/image/upload/w_640,c_limit,q_auto,f_jpg/",
            1,
        )
    elif media_type == "video" and "/video/upload/" in parsed.path:
        filename = parsed.path.rsplit("/", 1)[-1]
        stem = filename.rsplit(".", 1)[0]
        path = parsed.path.rsplit("/", 1)[0] + f"/so_{max(0, int(second))},w_640,c_limit,f_jpg/{stem}.jpg"
    else:
        raise ValueError("Upload type does not match the Cloudinary URL.")
    return urllib.parse.urlunsplit(
        (parsed.scheme, parsed.netloc, path, parsed.query, "")
    )


def read_cloudinary_sample(url: str) -> bytes:
    request = urllib.request.Request(
        url,
        headers={"User-Agent": "QuartierPlus-Grin-Moderator/1"},
    )
    with urllib.request.urlopen(request, timeout=15) as response:
        content = response.read(5 * 1024 * 1024 + 1)
    if len(content) > 5 * 1024 * 1024:
        raise ValueError("Moderation sample exceeds the Rekognition image limit.")
    return content


def analyze_upload(url: str, media_type: str, duration: float | None) -> dict:
    if rekognition is None:
        raise RuntimeError("AWS_REGION is required for upload moderation.")
    if media_type not in ("image", "video"):
        raise ValueError("Unsupported upload media type.")
    sample_times = (
        [0]
        if media_type == "image"
        else [
            max(0, (duration or 0) * fraction)
            for fraction in (0.01, 0.25, 0.5, 0.75, 0.99)
        ]
    )
    max_confidence = 0.0
    minor_detected = False
    for second in sample_times:
        sample_url = cloudinary_sample_url(url, media_type, second)
        image_bytes = read_cloudinary_sample(sample_url)
        labels = rekognition.detect_moderation_labels(
            Image={"Bytes": image_bytes},
            MinConfidence=FRAME_MIN_CONFIDENCE,
            MaxLabels=20,
        )
        for label in labels.get("ModerationLabels", []):
            max_confidence = max(max_confidence, float(label["Confidence"]))
        faces = rekognition.detect_faces(
            Image={"Bytes": image_bytes},
            Attributes=["AGE_RANGE"],
        )
        minor_detected = minor_detected or any(
            face.get("AgeRange", {}).get("Low", 100) < 18
            for face in faces.get("FaceDetails", [])
        )
    return {
        "score": round(max_confidence, 2),
        "minorDetected": minor_detected,
    }


class UploadModerationHandler(BaseHTTPRequestHandler):
    def do_POST(self) -> None:
        if self.path != "/v1/analyze-upload":
            self.send_error(404)
            return
        provided = self.headers.get("X-Grin-Moderation-Token", "")
        if (
            len(provided) != len(UPLOAD_MODERATION_SECRET)
            or not UPLOAD_MODERATION_SECRET
            or not hmac.compare_digest(provided, UPLOAD_MODERATION_SECRET)
        ):
            self.send_error(401)
            return
        try:
            length = int(self.headers.get("Content-Length", "0"))
            if length < 1 or length > 16_384:
                raise ValueError("Invalid request size.")
            payload = json.loads(self.rfile.read(length))
            media_type = payload.get("media_type")
            url = payload.get("url")
            duration = payload.get("duration")
            if (
                media_type not in ("image", "video")
                or not isinstance(url, str)
                or len(url) > 2048
                or (
                    media_type == "video"
                    and (
                        not isinstance(duration, (int, float))
                        or not math.isfinite(duration)
                        or duration <= 0
                    )
                )
            ):
                raise ValueError("Invalid upload analysis request.")
            result = analyze_upload(url, media_type, duration)
            body = json.dumps(result).encode()
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except Exception as error:
            logger.error("Upload moderation analysis failed: %s", error)
            self.send_error(503)

    def log_message(self, _format: str, *_args: object) -> None:
        return


def start_upload_moderation_server() -> None:
    if not UPLOAD_MODERATION_ENABLED:
        return
    if (
        not AWS_REGION
        or len(UPLOAD_MODERATION_SECRET) < 32
        or not CLOUDINARY_CLOUD_NAME
        or not 1 <= UPLOAD_MODERATION_HTTP_PORT <= 65535
    ):
        raise RuntimeError("Upload moderation worker configuration is incomplete.")
    server = ThreadingHTTPServer(
        ("0.0.0.0", UPLOAD_MODERATION_HTTP_PORT),
        UploadModerationHandler,
    )
    threading.Thread(target=server.serve_forever, daemon=True).start()
    logger.info(
        "Upload moderation endpoint enabled on port %s.",
        UPLOAD_MODERATION_HTTP_PORT,
    )


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
    if not TEXT_MODERATION_ENABLED:
        return
    from livekit.plugins import aws

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
            )
            try:
                entries = await asyncio.to_thread(get_moderation_lexicon)
                category = await asyncio.to_thread(
                    text_category, text, entries
                )
            except Exception:
                logger.exception("Unable to load the public-text moderation lexicon.")
                continue
            if category == "THREAT":
                await report_once(
                    participant_id,
                    track_sid,
                    "AUDIO",
                    "Threat",
                    85,
                )
            elif category == "INSULT":
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
        if not should_subscribe_to_track(publication.kind):
            continue
        publication.set_subscribed(True)


def should_subscribe_to_track(kind: rtc.TrackKind) -> bool:
    return (
        kind == rtc.TrackKind.KIND_VIDEO and AWS_REKOGNITION_ENABLED
    ) or (
        kind == rtc.TrackKind.KIND_AUDIO and TEXT_MODERATION_ENABLED
    )


@server.rtc_session(agent_name="grin-moderator")
async def moderate_grin(ctx: JobContext) -> None:
    moderation_enabled = AWS_REKOGNITION_ENABLED or TEXT_MODERATION_ENABLED
    if moderation_enabled and (
        not AWS_REGION or not EVENT_URL or len(EVENT_SECRET) < 32
    ):
        raise RuntimeError("Grin moderation agent configuration is incomplete.")

    jobs: set[asyncio.Task] = set()

    def track_subscribed(
        track: rtc.Track,
        publication: rtc.RemoteTrackPublication,
        participant: rtc.RemoteParticipant,
    ) -> None:
        if participant.attributes.get("grin_moderation_consent") != "true":
            return
        if track.kind == rtc.TrackKind.KIND_VIDEO and AWS_REKOGNITION_ENABLED:
            task = asyncio.create_task(
                monitor_video(track, participant.identity, publication.sid)
            )
        elif track.kind == rtc.TrackKind.KIND_AUDIO and TEXT_MODERATION_ENABLED:
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
        if (
            participant.attributes.get("grin_moderation_consent") == "true"
            and should_subscribe_to_track(publication.kind)
        ):
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
    start_upload_moderation_server()
    cli.run_app(server)
