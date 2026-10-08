// ChatGPT / Codex 搜索 instructions 纯字符串常量
// 拆分到独立模块，便于单元测试直接断言文案（无需加载 StorageService / WASM）
// 三套搜索语义严格分离：
//   Hosted     → provider-native web_search
//   Standalone → namespace=web / name=run → /backend-api/codex/alpha/search
//   Custom     → openchat_web_search / openchat_web_fetch（见 ChatGPTConversationService.SEARCH_INSTRUCTIONS）

// Codex 搜索模式语义判定规则（Hosted 和 Standalone 共用）
export const CODEX_SEARCH_MODE_SEMANTICS = `<!-- CODEX_SEARCH_MODE_SEMANTICS_V1 -->
## Web Search Modes in OpenChat

There are THREE distinct web search mechanisms. They are NOT interchangeable. When asked "what tool did you use" or "what search mode was used", identify the correct one from the conversation history items — NOT from the current instructions or current search mode.

### 1. Hosted Web Search (provider-native)
- History item type: \`web_search_call\` with \`action.type\` (e.g. \`search\`)
- Executed server-side by the Codex backend. NOT a client function tool.
- Do NOT call it \`web.run\`. Do NOT call it "Standalone" or a "function tool".
- \`action.sources\` may contain:
  - \`{ type: "url", url, title }\` — ordinary web page source
  - \`{ type: "api", name: "oai-weather" }\` — built-in API data source (e.g. weather)
- Both are still Hosted Web Search. An \`api\` source does NOT mean a separate "weather tool" was called; it means Hosted Search used an internal API data source. Describe it as: "Hosted Web Search used the built-in oai-weather data source."

### 2. Standalone Web Search (web.run)
- History item type: \`function_call\` with \`namespace: "web"\` and \`name: "run"\`, paired with a corresponding \`function_call_output\`
- Client-side tool executed via /backend-api/codex/alpha/search. Often referred to as \`web.run\` or Standalone Web Search.
- This is NEVER Hosted Web Search. Do NOT call it "Hosted", "hosted search", "本地搜索", or "local search".
- If the history contains \`{ type: "function_call", name: "run", namespace: "web" }\` + \`function_call_output\`, the search was Standalone — regardless of what the current instructions say about "web_search" or "Hosted".

### 3. OpenChat Custom Web Search
- History item type: \`function_call\` with \`name: "openchat_web_search"\` (no namespace)
- Client-side tool used by non-Codex custom providers.

## Rules for answering "what tool/mode did you use"

You MUST determine the search mode from the ACTUAL history item type in the conversation input. Do NOT guess from:
- the result content (web pages, weather data, news, etc. do NOT determine the mode)
- the current instructions (they describe the CURRENT session's tool, not the HISTORY)
- the current SearchMode (it applies to this turn only, not to previous turns)

Strict mapping:
- \`type: web_search_call\` → answer "Hosted Web Search". Do NOT answer \`web.run\`, "Standalone", or "function tool".
- \`type: function_call\` with \`namespace=web, name=run\` + \`function_call_output\` → answer "Standalone Web Search (web.run)". Do NOT answer "Hosted" or "hosted search".
- \`type: function_call\` with \`name=openchat_web_search\` → answer "OpenChat Custom Web Search".

## Most recent search takes priority

When the user asks about "刚才", "上一次", "刚刚", "the previous search", or "what search was used", identify the MOST RECENT completed search tool call in the conversation history.

- Most recent \`web_search_call\` → Hosted Web Search
- Most recent \`function_call(namespace=web, name=run)\` + \`function_call_output\` → Standalone Web Search

Do NOT classify an older search event when a newer completed search exists. For example, if the history contains both an earlier Hosted \`web_search_call\` and a later Standalone \`function_call web.run\`, and the user asks "刚才用了什么", the answer is Standalone — because that is the most recent search.

Examples:
- History item \`{ "type": "web_search_call", "action": { "type": "search" } }\` → This was Hosted Web Search
- History item \`{ "type": "function_call", "name": "run", "namespace": "web" }\` + \`{ "type": "function_call_output" }\` → This was Standalone Web Search (web.run)`

// Hosted 搜索指令：web_search 为 provider-native 工具，服务端执行
// 注意：Hosted 路径只注册 web_search，不存在 openchat_web_fetch，禁止声明不存在的 Tool
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

` + CODEX_SEARCH_MODE_SEMANTICS

// Standalone 搜索指令：web.run 通过 additional_tools 声明，模型自主决定是否调用
// open 支持 search-result ref 与 fully-qualified HTTP/HTTPS URL 两种 ref_id
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

` + CODEX_SEARCH_MODE_SEMANTICS
