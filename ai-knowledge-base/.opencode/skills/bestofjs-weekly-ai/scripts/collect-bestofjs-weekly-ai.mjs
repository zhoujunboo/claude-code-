import { mkdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const BEST_OF_JS_BASE_URL = 'https://bestofjs.org/projects';
const PAGE_LIMIT = 30;
const TARGET_COUNT = 15;
const MAX_PAGES = 3;

const POSITIVE_PATTERNS = [
  /\bai\b/i,
  /\bagent(s|ic)?\b/i,
  /\bllm(s)?\b/i,
  /\bgpt\b/i,
  /\brag\b/i,
  /\bprompt(ing)?\b/i,
  /\binference\b/i,
  /\bgemini\b/i,
  /\bclaude\b/i,
  /\bopenai\b/i,
  /\banthropic\b/i,
  /\bmodel(s)?\b/i,
  /meta-prompt/i,
  /context engineering/i,
  /spec-driven/i,
  /browser agents?/i,
  /ai-powered/i,
  /ai-friendly/i,
  /coding agent/i,
  /ai chat/i,
  /workflow automation/i
];

const POSITIVE_TAGS = new Set([
  'ai',
  'ai agents',
  'ai methodology',
  'ai builder'
]);

const NEGATIVE_PATTERNS = [
  /component library/i,
  /react components?/i,
  /css framework/i,
  /animation/i,
  /diagrams? from text/i,
  /markdown editor/i,
  /photo/i,
  /video/i,
  /drawing/i,
  /icon toolkit/i,
  /orm/i,
  /authentication/i,
  /database/i,
  /cms/i,
  /rich text editor/i,
  /desktop apps?/i
];

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const repoRoot = path.resolve(__dirname, '../../../..');

function decodeHtml(text) {
  return text
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

function normalizeText(text) {
  return decodeHtml(text).replace(/\s+/g, ' ').trim();
}

function stripHtml(html) {
  return normalizeText(html.replace(/<!-- -->/g, '').replace(/<[^>]+>/g, ' '));
}

async function fetchText(url) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000);

  try {
    const response = await fetch(url, {
      headers: {
        'user-agent': 'bestofjs-weekly-ai-skill',
        accept: 'text/html,application/json;q=0.9,*/*;q=0.8'
      },
      signal: controller.signal
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch ${url}: ${response.status} ${response.statusText}`);
    }

    return await response.text();
  } finally {
    clearTimeout(timeoutId);
  }
}

function parseStarsPerDay(cardHtml) {
  const cleaned = cardHtml.replace(/<!-- -->/g, '');
  const match = cleaned.match(/<span>\+<\/span><span>(\d+)<\/span><span>\.(\d+)<\/span>/i);
  if (!match) {
    return null;
  }

  return Number(`${match[1]}.${match[2]}`);
}

function parseTags(cardHtml) {
  const matches = [...cardHtml.matchAll(/href="\/projects\?[^\"]*?tags=[^\"]*?"[^>]*>([^<]+)<\/a>/g)];
  return matches.map((match) => normalizeText(match[1]));
}

function parseTitle(cardHtml, slug) {
  const explicitTitleMatches = [...cardHtml.matchAll(/class="whitespace-nowrap[^"]*" href="\/projects\/[^\"]+"[^>]*>([^<]+)<\/a>/g)]
    .map((match) => normalizeText(match[1]))
    .filter(Boolean);

  if (explicitTitleMatches.length > 0) {
    return explicitTitleMatches[0];
  }

  const titleRegex = new RegExp(`href=\"/projects/${slug}\"[^>]*>([^<]+)</a>`, 'g');
  const matches = [...cardHtml.matchAll(titleRegex)]
    .map((match) => normalizeText(match[1]))
    .filter(Boolean);

  if (matches.length > 0) {
    return matches[matches.length - 1];
  }

  const altMatch = cardHtml.match(/<img alt="([^"]+)"/i);
  return altMatch ? normalizeText(altMatch[1]) : slug;
}

function parseCard(cardHtml) {
  const slugMatch = cardHtml.match(/href="\/projects\/([^\"?]+)"/i);
  const githubMatch = cardHtml.match(/href="(https:\/\/github\.com\/[^\"?#]+\/[^\"?#]+)"/i);

  if (!slugMatch || !githubMatch) {
    return null;
  }

  const slug = slugMatch[1];
  const repoName = githubMatch[1].split('/').slice(-1)[0];
  const allExternalLinks = [...cardHtml.matchAll(/href="(https:\/\/[^\"]+)"/g)].map((match) => decodeHtml(match[1]));
  const homepage = allExternalLinks.find((url) => url !== githubMatch[1]) ?? null;
  const bestofjsTags = parseTags(cardHtml);
  const cardText = stripHtml(cardHtml);
  const parsedTitle = parseTitle(cardHtml, slug);
  const title = shouldUseRepoName(parsedTitle, slug, repoName) ? repoName : parsedTitle;
  const starsPerDay = parseStarsPerDay(cardHtml);

  return {
    slug,
    name: title,
    bestofjsUrl: `https://bestofjs.org/projects/${slug}`,
    githubUrl: githubMatch[1],
    homepage,
    starsPerDay,
    estimatedWeeklyStars: starsPerDay === null ? null : Math.round(starsPerDay * 7),
    bestofjsTags,
    cardText
  };
}

function normalizeIdentifier(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

function shouldUseRepoName(title, slug, repoName) {
  const normalizedTitle = normalizeIdentifier(title);
  const normalizedSlug = normalizeIdentifier(slug);
  const normalizedRepo = normalizeIdentifier(repoName);

  if (normalizedTitle.includes(normalizedSlug)) {
    return false;
  }

  return normalizedRepo === normalizedSlug;
}

function parseCards(html) {
  const cards = html
    .split('<tr data-testid="project-card"')
    .slice(1)
    .map((part) => `<tr data-testid="project-card"${part.split('</tr>')[0]}</tr>`)
    .map(parseCard)
    .filter(Boolean);

  const uniqueCards = [];
  const seen = new Set();

  for (const card of cards) {
    if (seen.has(card.slug)) {
      continue;
    }

    seen.add(card.slug);
    uniqueCards.push(card);
  }

  return uniqueCards;
}

function isAiRelated(project) {
  const tagHit = project.bestofjsTags.some((tag) => POSITIVE_TAGS.has(tag.toLowerCase()));
  const haystack = `${project.name} ${project.slug} ${project.cardText} ${project.bestofjsTags.join(' ')}`;
  const positiveHit = POSITIVE_PATTERNS.some((pattern) => pattern.test(haystack));
  const negativeHit = NEGATIVE_PATTERNS.some((pattern) => pattern.test(haystack));

  if (tagHit) {
    return true;
  }

  if (!positiveHit) {
    return false;
  }

  if (negativeHit && !POSITIVE_PATTERNS.slice(0, 12).some((pattern) => pattern.test(haystack))) {
    return false;
  }

  return true;
}

function inferCategory(project) {
  const text = `${project.name} ${project.cardText} ${project.bestofjsTags.join(' ')}`.toLowerCase();

  if (/coding agent|autonomous coding agent|open source coding agent/.test(text)) {
    return 'AI 编码代理';
  }

  if (/workflow|orchestration/.test(text) && /ai|agent/.test(text)) {
    return 'AI 工作流编排工具';
  }

  if (/cli|terminal/.test(text) && /ai|agent|gemini|claude|llm/.test(text)) {
    return '命令行 AI 助手';
  }

  if (/prompt|context engineering|spec-driven|method/.test(text)) {
    return 'AI 方法论与提示工程工具';
  }

  if (/language/.test(text)) {
    return 'AI 编程语言实验项目';
  }

  if (/agent/.test(text)) {
    return 'AI Agent 开发平台';
  }

  return 'AI 开发工具';
}

function inferFocus(project) {
  const text = `${project.cardText} ${project.bestofjsTags.join(' ')}`.toLowerCase();

  if (/coding agent|autonomous coding agent|open source coding agent/.test(text)) {
    return '代码生成、终端协作与自动执行';
  }

  if (/workflow|orchestration/.test(text) && /ai|agent/.test(text)) {
    return '多步骤任务编排与流程自动化';
  }

  if (/prompt|context engineering|spec-driven/.test(text)) {
    return '提示工程、上下文管理与规范驱动开发';
  }

  if (/language/.test(text)) {
    return '构建 AI 系统的语言抽象与开发体验';
  }

  if (/browser agents?/.test(text)) {
    return '浏览器智能体与网页自动化';
  }

  if (/chat/.test(text)) {
    return 'AI 对话界面与应用集成';
  }

  if (/toolkit|sdk|framework|platform/.test(text)) {
    return 'Agent 构建、扩展与集成能力';
  }

  if (/ai/.test(text)) {
    return 'AI 能力接入与实际落地';
  }

  return 'AI 应用开发与集成';
}

function inferScenario(project) {
  const text = `${project.cardText} ${project.bestofjsTags.join(' ')}`.toLowerCase();

  if (/coding agent|autonomous coding agent|open source coding agent/.test(text)) {
    return '代码助手、研发自动化';
  }

  if (/workflow|orchestration/.test(text) && /ai|agent/.test(text)) {
    return '企业流程、Agent 工作流';
  }

  if (/prompt|spec-driven|context/.test(text)) {
    return '团队协作、AI 编程规范';
  }

  if (/cli|terminal/.test(text) && /ai|agent|gemini|claude|llm/.test(text)) {
    return '终端开发、个人效率';
  }

  if (/browser agents?|automation/.test(text)) {
    return '网页操作、浏览器自动化';
  }

  if (/chat/.test(text)) {
    return 'AI 助手、会话式产品';
  }

  return '产品原型、智能助手';
}

function buildSummary(project) {
  const category = inferCategory(project);
  const focus = inferFocus(project);
  const scenario = inferScenario(project);
  return `${project.name} 是一个${category}，聚焦${focus}，适合${scenario}等场景，近期在 Best of JS 周榜增长很快。`;
}

async function collect() {
  const candidates = [];

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const html = await fetchText(`${BEST_OF_JS_BASE_URL}?page=${page}&limit=${PAGE_LIMIT}&sort=weekly`);
    const pageCards = parseCards(html);

    for (const card of pageCards) {
      if (!candidates.some((item) => item.slug === card.slug)) {
        candidates.push(card);
      }
    }

    if (candidates.length >= PAGE_LIMIT * page) {
      continue;
    }
  }

  const items = candidates
    .filter(isAiRelated)
    .sort((left, right) => (right.starsPerDay ?? 0) - (left.starsPerDay ?? 0))
    .slice(0, TARGET_COUNT)
    .map((project, index) => ({
      rank: index + 1,
      name: project.name,
      slug: project.slug,
      bestofjsUrl: project.bestofjsUrl,
      githubUrl: project.githubUrl,
      homepage: project.homepage,
      starsPerDay: project.starsPerDay,
      estimatedWeeklyStars: project.estimatedWeeklyStars,
      bestofjsTags: project.bestofjsTags,
      summary: buildSummary(project)
    }));

  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const output = {
    source: 'bestofjs',
    skill: 'bestofjs-weekly-ai',
    collectedAt: now.toISOString(),
    ranking: {
      period: 'last_7_days',
      sort: 'weekly',
      limit: TARGET_COUNT,
      filter: 'ai_related_only'
    },
    items
  };

  const outputDir = path.join(repoRoot, 'knowledge', 'raw');
  const outputPath = path.join(outputDir, `bestofjs-weekly-ai-${date}.json`);

  await mkdir(outputDir, { recursive: true });
  await rm(outputPath, { force: true });
  await writeFile(outputPath, `${JSON.stringify(output, null, 2)}\n`, 'utf8');

  console.log(outputPath);
  console.log(`items=${items.length}`);
}

await collect();
