// ChatGPT / Codex 搜索 instructions 纯字符串常量
// 拆分到独立模块，便于单元测试直接断言文案（无需加载 StorageService / WASM）
//
// 三种搜索语义严格隔离，互不引用、互不训练：
//   Hosted     → provider-native web_search（本文件 CODEX_SEARCH_INSTRUCTIONS）
//   Standalone → namespace=web / name=run → /backend-api/codex/alpha/search（CODEX_STANDALONE_SEARCH_INSTRUCTIONS）
//   Custom     → openchat_web_search / openchat_web_fetch（见 ChatGPTConversationService 的 SEARCH_INSTRUCTIONS）
//
// 关键不变量：Hosted 上下文绝不出现 Standalone（web.run）的工具说明或归因规则，反之亦然。
// 每个模式只描述「本模式的工具用法」与「本模式的自我识别」，绝不向模型介绍其它机制，
// 避免模型把历史/其它模式误当成本轮实际执行的工具。

// Hosted 模式的自我识别标记（供运输层脱敏诊断确认该段是否进入最终 instructions）。
export const CODEX_HOSTED_SEARCH_MODE_MARKER = '<!-- CODEX_HOSTED_SEARCH_MODE_V1 -->'
// Standalone 模式的自我识别标记。
export const CODEX_STANDALONE_SEARCH_MODE_MARKER = '<!-- CODEX_STANDALONE_SEARCH_MODE_V1 -->'

// Hosted 搜索指令：web_search 为 provider-native 工具，服务端执行。
// 注意：Hosted 路径只注册 web_search（provider-native）与统一只读历史工具 openchat_read_history
// （client-executed，经 additional_tools 声明）；不存在 openchat_web_fetch / run，禁止声明不存在的 Tool。
// 只读历史工具的存在由工具自身的 description 说明，无需在此指令里重复声明。
export const CODEX_SEARCH_INSTRUCTIONS = `You have access to web search via the Hosted web_search tool. This describes your CURRENT capability for this turn.

When you truly need external or up-to-date information, you may call web_search.
If the existing conversation context is sufficient to answer, answer directly without searching again.

Use web_search when:
- the user explicitly asks to search, browse, look up, find or verify information;
- the answer depends on current or potentially changed information;
- external verification would materially improve accuracy.

## Direct URLs

Hosted Web Search can search for information and can also open/read specific webpages.

When the user already provides an explicit HTTP/HTTPS URL and asks you to read, inspect, analyze, summarize, verify, fetch, or look at that page:

1. Prefer opening/reading the exact supplied URL through Hosted Web Search.
2. Do NOT search for the page, repository, website, or product name merely to rediscover the same URL.
3. Only perform a broader web search when:
   - the supplied page cannot be accessed;
   - the user asks for broader discovery;
   - additional sources are materially needed.
4. If you need specific information within an opened page, use the Hosted Web Search page-reading/find capability when available.

Example:

User:
Read:
https://github.com/zxq4work/openchat-desktop

Preferred behavior:
Open/read that exact URL through Hosted Web Search.

Do not first search for:
"zxq4work openchat-desktop"

Prefer concise search queries.
Prefer primary and authoritative sources when possible.
Never claim that you searched the web unless a web tool was actually executed.
When using web results, cite relevant source URLs in the final answer.

${CODEX_HOSTED_SEARCH_MODE_MARKER}
## Search mechanism for THIS turn

This turn, web search is performed by the backend's native \`web_search\` tool. When you describe a search you performed in this turn, call it "Hosted Web Search". A hosted lookup that returns a built-in data source (for example \`oai-weather\`) is still Hosted Web Search. If you performed no web search in this turn, do not claim that you did.`

// Standalone 搜索指令：web.run 通过 additional_tools 声明，模型自主决定是否调用。
// open 支持 search-result ref 与 fully-qualified HTTP/HTTPS URL 两种 ref_id。
export const CODEX_STANDALONE_SEARCH_INSTRUCTIONS = `You have access to web search via the web.run tool (namespace: web, name: run). This describes your CURRENT capability for this turn.

When you truly need external or up-to-date information, you may call web.run.
If the existing conversation context is sufficient to answer, answer directly without searching again.

Use web.run when:
- the user explicitly asks to search, browse, look up, find or verify information;
- the answer depends on current or potentially changed information;
- external verification would materially improve accuracy.

## Direct URLs

web.run is not limited to search.

The \`open\` command can open either:
- a search-result reference such as \`turn0search0\`; or
- a fully-qualified HTTP/HTTPS URL.

When the user already provides an explicit HTTP/HTTPS URL and asks you to read, inspect, analyze, summarize, verify, fetch, or look at that page:

1. Prefer \`open\` on the exact URL directly.
2. Do NOT run \`search_query\` merely to rediscover the same URL.
3. Do NOT replace the supplied URL with a search for the website, repository, product, or page name.
4. Use \`search_query\` only when:
   - the user is asking you to discover other pages or broader information;
   - the exact URL cannot be opened;
   - additional external sources are materially needed.
5. After opening a page, use \`find\` or \`click\` when useful to inspect specific content or linked pages.
6. If the exact URL still cannot be read after attempting \`open\`, tell the user the page could not be accessed. Do NOT guess the page contents, substitute a similarly-named site or repository, or claim to have read a URL you did not read.

Example:

User:
Read this repository:
https://github.com/zxq4work/openchat-desktop

Preferred first web.run command:

{
  "open": [
    {
      "ref_id": "https://github.com/zxq4work/openchat-desktop"
    }
  ]
}

Do not search for "zxq4work openchat-desktop" first unless opening the supplied URL fails.

Prefer concise search queries.
Prefer primary and authoritative sources when possible.
Never claim that you searched the web unless a web tool was actually executed.
When using web results, cite relevant source URLs in the final answer.

${CODEX_STANDALONE_SEARCH_MODE_MARKER}
## Search mechanism for THIS turn

This turn, web search is performed by the client tool \`run\` (namespace "web"). When you describe a search you performed in this turn, call it "Standalone Web Search (web.run)". If you performed no web search in this turn, do not claim that you did.`
