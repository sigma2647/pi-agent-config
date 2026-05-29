import type { FetchResult } from "../core.ts";
import { type Extractor, fetchJson } from "./types.ts";

// B站视频页面是 JS 重度渲染的，web_fetch 抓 HTML 无效。但 B站有公开 API
// 可以无需认证获取视频信息。
//
// API: GET https://api.bilibili.com/x/web-interface/view?bvid=xxx
//      GET https://api.bilibili.com/x/web-interface/view?aid=xxx

const BILI_VIDEO_RE = /^\/video\/(BV[\dA-Za-z]+|av\d+)/;

interface BiliVideoInfo {
	code: number;
	data?: {
		bvid: string;
		aid: number;
		title: string;
		desc: string;
		owner?: { name: string; mid: number };
		stat?: {
			view: number;
			danmaku: number;
			favorite: number;
			coin: number;
			like: number;
			reply: number;
			share: number;
		};
		pic: string;
		pubdate: number;
		tag?: { tag_name: string }[];
		duration: number;
		pages?: { part: string; duration: number }[];
	};
}

function formatDuration(seconds: number): string {
	if (!Number.isFinite(seconds) || seconds < 0) return "?";
	const h = Math.floor(seconds / 3600);
	const m = Math.floor((seconds % 3600) / 60);
	const s = seconds % 60;
	return h > 0
		? `${h}:${String(m).padStart(2, "0")}:${String(s).padStart(2, "0")}`
		: `${m}:${String(s).padStart(2, "0")}`;
}

function formatCount(n: number): string {
	if (!Number.isFinite(n)) return "?";
	if (n >= 100_000_000) return (n / 100_000_000).toFixed(1) + "亿";
	if (n >= 10_000) return (n / 10_000).toFixed(1) + "万";
	return String(n);
}

function safeDate(ts: number | undefined): string {
	if (!ts || !Number.isFinite(ts)) return "?";
	const d = new Date(ts * 1000);
	return Number.isNaN(d.getTime()) ? "?" : d.toISOString().slice(0, 10);
}

async function extractBilibili(
	url: URL,
	signal?: AbortSignal,
): Promise<FetchResult | null> {
	const m = url.pathname.match(BILI_VIDEO_RE);
	if (!m) return null;

	const id = m[1];
	const apiParam = id.startsWith("BV") ? `bvid=${id}` : `aid=${id.slice(2)}`;
	const apiUrl = `https://api.bilibili.com/x/web-interface/view?${apiParam}`;

	const info = await fetchJson<BiliVideoInfo>(apiUrl, signal);
	if (!info || info.code !== 0 || !info.data) return null;

	const d = info.data;
	const lines: string[] = [
		`# ${d.title}`,
		"",
		`> UP主: ${d.owner?.name || "?"} · 时长: ${formatDuration(d.duration)} · 发布: ${safeDate(d.pubdate)}`,
	];

	if (d.stat) {
		lines.push(
			`> 播放: ${formatCount(d.stat.view)} · 弹幕: ${formatCount(d.stat.danmaku)} · 点赞: ${formatCount(d.stat.like)} · 投币: ${formatCount(d.stat.coin)} · 收藏: ${formatCount(d.stat.favorite)} · 评论: ${formatCount(d.stat.reply)}`,
		);
	}
	lines.push("", "---", "");

	if (d.desc?.trim()) {
		lines.push(d.desc.trim(), "");
	}

	if (d.pages && d.pages.length > 1) {
		lines.push("## 分P列表", "");
		for (let i = 0; i < d.pages.length; i++) {
			lines.push(
				`${i + 1}. ${d.pages[i].part} (${formatDuration(d.pages[i].duration)})`,
			);
		}
		lines.push("");
	}

	return {
		url: url.href,
		title: d.title,
		content: lines.join("\n"),
		error: null,
	};
}

export const bilibiliExtractor: Extractor = {
	name: "bilibili",
	match: (url) =>
		/(^|\.)bilibili\.com$/.test(url.hostname) &&
		BILI_VIDEO_RE.test(url.pathname),
	extract: extractBilibili,
};
