import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const API_BASE = "https://www.googleapis.com/youtube/v3";
const CHANNEL_HANDLE = "cit-west-toronto";
const VIDEO_LIMIT = 3;
const HEARTBEAT_DAYS = 30;
const apiKey = process.env.YOUTUBE_API_KEY;

if (!apiKey) {
  throw new Error("YOUTUBE_API_KEY is required");
}

async function youtube(endpoint, params) {
  const url = new URL(`${API_BASE}/${endpoint}`);
  for (const [key, value] of Object.entries({ ...params, key: apiKey })) {
    url.searchParams.set(key, String(value));
  }
  const response = await fetch(url, { headers: { Accept: "application/json" } });
  const payload = await response.json();
  if (!response.ok) {
    const message = payload?.error?.message || `${response.status} ${response.statusText}`;
    throw new Error(`YouTube ${endpoint} request failed: ${message}`);
  }
  return payload;
}

function thumbnailFor(snippet) {
  const thumbnails = snippet?.thumbnails || {};
  return thumbnails.maxres?.url || thumbnails.standard?.url || thumbnails.high?.url || thumbnails.medium?.url || thumbnails.default?.url || "";
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonIfChanged(path, value) {
  const next = `${JSON.stringify(value, null, 2)}\n`;
  let current = "";
  try { current = await readFile(path, "utf8"); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  if (current === next) return false;
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, next, "utf8");
  return true;
}

const channelResponse = await youtube("channels", {
  part: "snippet,contentDetails",
  forHandle: CHANNEL_HANDLE,
});
const channel = channelResponse.items?.[0];
if (!channel) throw new Error(`No YouTube channel found for @${CHANNEL_HANDLE}`);

const uploadsPlaylistId = channel.contentDetails?.relatedPlaylists?.uploads;
if (!uploadsPlaylistId) throw new Error("The channel uploads playlist was not returned");

const playlistResponse = await youtube("playlistItems", {
  part: "contentDetails",
  playlistId: uploadsPlaylistId,
  maxResults: 10,
});
const candidateIds = (playlistResponse.items || []).map(item => item.contentDetails?.videoId).filter(Boolean);
if (!candidateIds.length) throw new Error("The channel has no uploaded videos available through the API");

const videosResponse = await youtube("videos", {
  part: "snippet,status",
  id: candidateIds.join(","),
});
const byId = new Map((videosResponse.items || []).map(video => [video.id, video]));
const videos = candidateIds
  .map(id => byId.get(id))
  .filter(video => video?.status?.privacyStatus === "public" && video?.status?.embeddable !== false)
  .slice(0, VIDEO_LIMIT)
  .map(video => ({
    id: video.id,
    title: video.snippet.title,
    publishedAt: video.snippet.publishedAt,
    thumbnail: thumbnailFor(video.snippet),
    url: `https://www.youtube.com/watch?v=${video.id}`,
    embedUrl: `https://www.youtube-nocookie.com/embed/${video.id}`,
  }));

const dataPath = resolve("data/youtube-videos.json");
const heartbeatPath = resolve("data/youtube-heartbeat.json");
const dataChanged = await writeJsonIfChanged(dataPath, {
  channelId: channel.id,
  channelHandle: `@${CHANNEL_HANDLE}`,
  channelTitle: channel.snippet?.title || "Church in Toronto West",
  videos,
});

const heartbeat = await readJson(heartbeatPath, { lastActivityAt: "1970-01-01T00:00:00.000Z" });
const lastActivity = Date.parse(heartbeat.lastActivityAt || "1970-01-01T00:00:00.000Z");
const heartbeatDue = !Number.isFinite(lastActivity) || Date.now() - lastActivity >= HEARTBEAT_DAYS * 24 * 60 * 60 * 1000;
if (dataChanged || heartbeatDue) {
  await writeJsonIfChanged(heartbeatPath, { lastActivityAt: new Date().toISOString() });
}

console.log(JSON.stringify({ channelId: channel.id, uploadsPlaylistId, videoCount: videos.length, dataChanged, heartbeatDue }));
