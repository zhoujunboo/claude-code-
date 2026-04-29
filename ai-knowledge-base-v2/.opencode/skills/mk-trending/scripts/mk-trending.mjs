const COURSE_LIST_URL = 'https://coding.imooc.com/?c=AI';
const COURSE_BASE_URL = 'https://coding.imooc.com';
const TOP_LIMIT = 20;
const REQUEST_TIMEOUT_MS = 4500;

const FILTER_PATTERNS = [
  /\bai\b/i,
  /\bllm\b/i,
  /\bagent\b/i,
  /\bml\b/i,
  /aigc/i,
  /rag/i,
  /mcp/i,
  /a2a/i,
  /langchain/i,
  /langgraph/i,
  /dify/i,
  /coze/i,
  /deepseek/i,
  /cursor/i,
  /copilot/i,
  /chatgpt/i,
  /manus/i,
  /智能体/,
  /人工智能/,
  /大模型/,
  /机器学习/
];

const TOPIC_RULES = [
  { topic: 'ai', pattern: /\bai\b|人工智能|aigc/i },
  { topic: 'llm', pattern: /\bllm\b|大模型/i },
  { topic: 'agent', pattern: /\bagent\b|智能体/i },
  { topic: 'ml', pattern: /\bml\b|机器学习/i },
  { topic: 'rag', pattern: /rag/i },
  { topic: 'mcp', pattern: /mcp/i },
  { topic: 'a2a', pattern: /a2a/i },
  { topic: 'langchain', pattern: /langchain/i },
  { topic: 'langgraph', pattern: /langgraph/i },
  { topic: 'dify', pattern: /dify/i },
  { topic: 'coze', pattern: /coze/i },
  { topic: 'deepseek', pattern: /deepseek/i },
  { topic: 'cursor', pattern: /cursor/i },
  { topic: 'copilot', pattern: /copilot/i },
  { topic: 'chatgpt', pattern: /chatgpt/i }
];

function decodeHtml(text) {
  return text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#x2F;/g, '/')
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)));
}

function stripHtml(text) {
  return decodeHtml(text)
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

async function fetchText(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: {
        'user-agent': 'mk-trending-skill',
        accept: 'text/html,application/xhtml+xml'
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch ${url}: ${response.status}`);
    }

    return await response.text();
  } finally {
    clearTimeout(timeoutId);
  }
}

function parseCourseCards(html) {
  const matches = [...html.matchAll(/<li class="course-card"[\s\S]*?<\/li>/g)];

  return matches.slice(0, TOP_LIMIT).map((match) => {
    const block = match[0];
    const name = stripHtml(block.match(/<p class="title[^"]*">([\s\S]*?)<\/p>/)?.[1] ?? '');
    const relativeUrl = decodeHtml(block.match(/<a[^>]*href="([^"]*\/class\/\d+\.html)"/i)?.[1] ?? '');
    const starsText = block.match(/(\d+)人报名/)?.[1] ?? '0';

    return {
      name,
      url: relativeUrl ? new URL(relativeUrl, COURSE_BASE_URL).toString() : '',
      stars: Number(starsText)
    };
  }).filter((item) => item.name && item.url && Number.isFinite(item.stars));
}

function isAiRelated(text) {
  return FILTER_PATTERNS.some((pattern) => pattern.test(text));
}

function extractDescription(html) {
  const candidates = [
    stripHtml(
      html.match(/<div class="title-box"[^>]*>\s*<h1>[\s\S]*?<\/h1>\s*<h2>([\s\S]*?)<\/h2>/)?.[1] ?? ''
    ),
    stripHtml(html.match(/<div class="dec-box">\s*<p>([\s\S]*?)<\/p>/)?.[1] ?? ''),
    stripHtml(html.match(/<div class="introduce-content">[\s\S]*?<p>([\s\S]{20,}?)<\/p>/)?.[1] ?? ''),
    decodeHtml(html.match(/<meta name="description" content="([^"]*)"/i)?.[1] ?? '').trim()
  ];

  return candidates.find((candidate) => (
    candidate
    && !candidate.includes('慕课网实战课程结合视频快捷方便的体验')
  )) ?? '';
}

function inferTopics(text) {
  return TOPIC_RULES.filter(({ pattern }) => pattern.test(text)).map(({ topic }) => topic);
}

function validateItems(items) {
  if (!Array.isArray(items)) {
    return false;
  }

  return items.every((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return false;
    }

    if (typeof item.name !== 'string' || item.name.trim() === '') {
      return false;
    }

    if (typeof item.url !== 'string' || !/^https:\/\//.test(item.url)) {
      return false;
    }

    if (!Number.isInteger(item.stars) || item.stars < 0) {
      return false;
    }

    if (!Array.isArray(item.topics) || item.topics.some((topic) => typeof topic !== 'string' || topic.trim() === '')) {
      return false;
    }

    if (typeof item.description !== 'string' || item.description.trim() === '') {
      return false;
    }

    return true;
  });
}

async function main() {
  try {
    const html = await fetchText(COURSE_LIST_URL);
    const courses = parseCourseCards(html);
    const candidates = courses.filter((course) => isAiRelated(course.name));

    const items = await Promise.all(candidates.map(async (course) => {
      const detailHtml = await fetchText(course.url);
      const description = extractDescription(detailHtml) || course.name;
      const haystack = `${course.name} ${description}`;

      if (!isAiRelated(haystack)) {
        return null;
      }

      return {
        name: course.name,
        url: course.url,
        stars: course.stars,
        topics: inferTopics(haystack),
        description
      };
    }));

    const output = items.filter(Boolean);
    if (!validateItems(output)) {
      console.log('[]');
      return;
    }

    console.log(JSON.stringify(output, null, 2));
  } catch {
    console.log('[]');
  }
}

await main();
