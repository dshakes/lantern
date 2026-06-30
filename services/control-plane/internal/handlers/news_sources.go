package handlers

// news_sources.go — curated source registry for the news_radar loop agent.
//
// kind values:
//   rss   — RSS 2.0 feed (uses <item><link> + <pubDate>/<author>)
//   atom  — Atom feed (uses <entry><link href> + <updated>/<author>)
//   github — GitHub releases Atom feed (same atom parsing)
//   gh_search — GitHub repository search API (JSON)
//   hn    — HN Algolia search API (JSON)
//   reddit — Reddit JSON API (.json suffix)
//
// Sources marked unavailable=true have no public machine-readable feed;
// the loop logs a skip and continues (never fails the whole run).

type newsSource struct {
	Name      string
	Category  string // labs|people|coding-tools|aggregators
	Kind      string // rss|atom|github|gh_search|hn|reddit
	URL       string
	Available bool // false = no public feed; logged as skip
}

// newsSources is the curated feed registry. The loop iterates this slice
// concurrently (bounded to 8 workers). Add new entries here; the loop picks
// them up on the next run with no code change.
var newsSources = []newsSource{
	// ---------- labs ----------
	{Name: "Anthropic News", Category: "labs", Kind: "atom", URL: "https://www.anthropic.com/news/rss.xml", Available: true},
	{Name: "OpenAI Blog", Category: "labs", Kind: "rss", URL: "https://openai.com/blog/rss.xml", Available: true},
	{Name: "Google DeepMind Blog", Category: "labs", Kind: "atom", URL: "https://deepmind.google/blog/rss.xml", Available: true},
	{Name: "Google AI Blog", Category: "labs", Kind: "atom", URL: "https://blog.research.google/feeds/posts/default", Available: true},
	{Name: "AWS Machine Learning Blog", Category: "labs", Kind: "rss", URL: "https://aws.amazon.com/blogs/machine-learning/feed/", Available: true},
	{Name: "Meta AI Blog", Category: "labs", Kind: "atom", URL: "https://ai.meta.com/blog/rss/", Available: true},
	{Name: "Mistral AI Blog", Category: "labs", Kind: "rss", URL: "https://mistral.ai/news/rss/", Available: true},
	{Name: "HuggingFace Blog", Category: "labs", Kind: "rss", URL: "https://huggingface.co/blog/feed.xml", Available: true},
	{Name: "NVIDIA Developer Blog", Category: "labs", Kind: "rss", URL: "https://developer.nvidia.com/blog/feed/", Available: true},
	// Chinese labs — public feeds where they exist; skip-logged when absent.
	{Name: "DeepSeek", Category: "labs", Kind: "rss", URL: "https://www.deepseek.com/blog/rss.xml", Available: false}, // no public RSS
	{Name: "Qwen/Alibaba", Category: "labs", Kind: "rss", URL: "https://qwenlm.github.io/feed.xml", Available: true},
	{Name: "Moonshot/Kimi", Category: "labs", Kind: "rss", URL: "https://www.moonshot.cn/blog/rss.xml", Available: false}, // no public RSS
	{Name: "Zhipu AI", Category: "labs", Kind: "rss", URL: "https://www.zhipuai.cn/blog/feed.xml", Available: false},      // no public RSS

	// ---------- people ----------
	{Name: "Simon Willison", Category: "people", Kind: "atom", URL: "https://simonwillison.net/atom/everything/", Available: true},
	{Name: "Lilian Weng", Category: "people", Kind: "atom", URL: "https://lilianweng.github.io/index.xml", Available: true},
	// Sebastian Raschka — "Ahead of AI" (Substack); one of the most-read ML educators.
	{Name: "Sebastian Raschka", Category: "people", Kind: "rss", URL: "https://magazine.sebastianraschka.com/feed", Available: true},
	{Name: "The Batch (deeplearning.ai)", Category: "people", Kind: "rss", URL: "https://www.deeplearning.ai/the-batch/feed/", Available: true},
	// Andrej Karpathy posts on X/Twitter and GitHub; no standalone RSS.
	{Name: "Andrej Karpathy", Category: "people", Kind: "rss", URL: "", Available: false},
	// swyx / Latent Space podcast has its own feed.
	{Name: "Latent Space (swyx)", Category: "people", Kind: "rss", URL: "https://www.latent.space/feed", Available: true},

	// ---------- coding-tools ----------
	// GitHub releases Atom feeds — always parseable as Atom.
	{Name: "Claude Code releases", Category: "coding-tools", Kind: "github", URL: "https://github.com/anthropics/claude-code/releases.atom", Available: true},
	{Name: "Gemini CLI releases", Category: "coding-tools", Kind: "github", URL: "https://github.com/google-gemini/gemini-cli/releases.atom", Available: true},
	{Name: "Aider releases", Category: "coding-tools", Kind: "github", URL: "https://github.com/Aider-AI/aider/releases.atom", Available: true},
	// OpenAI Codex and Cursor do not have public GitHub release atoms; skip.
	{Name: "OpenAI Codex", Category: "coding-tools", Kind: "rss", URL: "", Available: false},
	{Name: "Cursor", Category: "coding-tools", Kind: "rss", URL: "", Available: false},
	// Cline (formerly Claude-dev): active GitHub repo.
	{Name: "Cline releases", Category: "coding-tools", Kind: "github", URL: "https://github.com/cline/cline/releases.atom", Available: true},
	// OpenRouter blog.
	{Name: "OpenRouter Blog", Category: "coding-tools", Kind: "atom", URL: "https://openrouter.ai/blog/rss", Available: true},
	// GitHub trending/star-velocity searches for claude-code-related repos.
	{Name: "GitHub: claude-code trending", Category: "coding-tools", Kind: "gh_search", URL: "https://api.github.com/search/repositories?q=claude-code+OR+topic:claude-code&sort=stars&order=desc&per_page=10", Available: true},
	{Name: "GitHub: gemini-cli trending", Category: "coding-tools", Kind: "gh_search", URL: "https://api.github.com/search/repositories?q=gemini-cli+OR+topic:gemini-cli&sort=stars&order=desc&per_page=10", Available: true},

	// ---------- aggregators ----------
	// Hacker News via Algolia (filter score>50 + AI keywords).
	{Name: "HackerNews", Category: "aggregators", Kind: "hn", URL: "https://hn.algolia.com/api/v1/search_by_date?query=AI+LLM+GPT+Claude+Gemini&tags=story&numericFilters=points>50&hitsPerPage=20", Available: true},
	// Reddit.
	{Name: "r/LocalLLaMA", Category: "aggregators", Kind: "reddit", URL: "https://www.reddit.com/r/LocalLLaMA.json?limit=25", Available: true},
	{Name: "r/ClaudeAI", Category: "aggregators", Kind: "reddit", URL: "https://www.reddit.com/r/ClaudeAI.json?limit=25", Available: true},
	// Podcasts — RSS feeds for episode titles/links.
	{Name: "Latent Space Podcast", Category: "aggregators", Kind: "rss", URL: "https://www.latent.space/feed", Available: true},
	{Name: "Dwarkesh Podcast", Category: "aggregators", Kind: "rss", URL: "https://www.dwarkeshpatel.com/feed", Available: true},
	{Name: "No Priors Podcast", Category: "aggregators", Kind: "rss", URL: "https://feeds.simplecast.com/Ory84uU7", Available: true},
}
