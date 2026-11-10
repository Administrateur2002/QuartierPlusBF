import { Router } from "express";
import {
  createEpisode,
  createEpisodePoll,
  createSeason,
  createSeries,
  getResume,
  getSeries,
  getEpisodePoll,
  getEpisodePollResults,
  listMySeries,
  listSeries,
  publishSeries,
  saveEpisodeProgress,
  signSeriesMediaUpload,
  voteOnEpisodePoll,
} from "../controllers/seriesController.js";
import { authMiddleware } from "../middlewares/authMiddleware.js";
import { optionalAuthMiddleware } from "../middlewares/optionalAuthMiddleware.js";
import { mediaSignatureRateLimit } from "../middlewares/sensitiveRateLimits.js";

const router = Router();

router.get("/", listSeries);
router.get("/mine", authMiddleware, listMySeries);
router.get("/resume", authMiddleware, getResume);
router.post("/", authMiddleware, createSeries);
router.post("/:seriesId/media/sign", authMiddleware, mediaSignatureRateLimit, signSeriesMediaUpload);
router.get("/:seriesId", optionalAuthMiddleware, getSeries);
router.post("/:seriesId/publish", authMiddleware, publishSeries);
router.post("/:seriesId/seasons", authMiddleware, createSeason);
router.post("/seasons/:seasonId/episodes", authMiddleware, createEpisode);
router.post("/episodes/:episodeId/progress", authMiddleware, saveEpisodeProgress);
router.post("/episodes/:episodeId/polls", authMiddleware, createEpisodePoll);
router.get("/episodes/:episodeId/poll", optionalAuthMiddleware, getEpisodePoll);
router.post("/episodes/:episodeId/vote", authMiddleware, voteOnEpisodePoll);
router.get("/episodes/:episodeId/poll/results", authMiddleware, getEpisodePollResults);

export default router;