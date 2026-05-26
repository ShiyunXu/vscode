# VSCode Qwen Compaction Runbook: `shiyunxu/fireworks-compaction-v0.49.14`

Changes on top of `ryangabriel/custom_trajectory_compaction_model` to enforce Fireworks Qwen-based compaction for all models with full observability.

## Problem

The original PR introduced a `DirectCompactionEndpoint` for Fireworks and `resolveCompactionEndpoint()` routing, but several model-specific code paths bypassed it:

1. **Anthropic models** (Opus 4.6, Sonnet 4.5+) — `isAnthropicCompactionEnabled()` set `summarizationEnabled = false`, routing compaction to Anthropic's server-side `compact-2026-01-12` beta instead of Fireworks.
2. **GPT/Codex models** (GPT-5.3-Codex, GPT-5.4, etc.) — `this.prompt === AgentPrompt` check excluded model-specific prompt classes (`Gpt53CodexPrompt`, `Gpt54Prompt`, etc.), disabling the `ConversationHistorySummarizer` pipeline entirely.
3. **Responses API models** — `useTruncation = true` set `safeBudget = MAX_SAFE_INTEGER`, preventing `BudgetExceededError` from ever triggering foreground compaction.
4. **`/compact` slash command** — Used a raw `fetch()` to Fireworks (bypassing the SDK), so compaction requests never appeared in the Chat Debugger or went through the standard `makeChatRequest2` pipeline.
5. **Build process** — `npm run package` runs `vsce package` without rebuilding `dist/extension.js`, so source changes weren't compiled into shipped VSIXs. Must run `npx tsx .esbuild.mts --sourcemaps` first.

## Changes

### `agentIntent.ts`
- **Forced `summarizationEnabled = true`** for all models — removed `this.prompt === AgentPrompt`, `!responsesCompactionContextManagementEnabled`, and `!anthropicCompactionEnabled` guards
- **Disabled Responses API truncation** — `useTruncation = false` so `BudgetExceededError` triggers properly
- **Removed raw `fetch()` from `/compact`** — the slash command now uses the same SDK pipeline as auto-compaction (`ConversationHistorySummarizer` → `resolveCompactionEndpoint()` → Fireworks → `makeChatRequest2`)
- **Removed Responses API compaction early-return** in `/compact` handler
- **Added `[/compact]` logging** throughout the handler (trigger, Fireworks request/response, SDK path status, errors)

### `chatEndpoint.ts`
- **Disabled `compact-2026-01-12` Anthropic beta header** — prevents Anthropic server-side compaction from running, ensuring all compaction goes through our Fireworks pipeline

### `summarizedConversationHistory.tsx`
- **Added `_lastCompactionMessages` field** — captures the request body before `makeChatRequest2` for debugging
- **Added `getSummaryWithRetry()`** — single retry wrapper for transient failures (e.g., empty `choices` from Fireworks)
- **Added failed request dump** — on failure, writes full request to `~/compaction_failed_{mode}_{timestamp}.json`
- **Added detailed logging** — compaction start, endpoint resolution, `makeChatRequest2` send/complete with timing and message counts

### `compactionEndpoint.ts`
- **Fixed `max_prompt_tokens`** — changed from 260,000 → 250,000 (previous value + 8,192 output tokens = 268,192 exceeded the model's 262,144 context limit)

### `package.json`
- Version bumped to `0.49.14`

## Build & Install

```bash
cd extensions/copilot
npx tsx .esbuild.mts --sourcemaps   # MUST compile first — vsce package does NOT rebuild!
npm run package
code --install-extension copilot-chat-0.49.14.vsix --force
# Reload VS Code window
```

## Observability

After these changes, all compaction (both `/compact` and auto-compaction) is visible in:

| Location | What to search for |
|----------|-------------------|
| **Output panel → Copilot Chat** | `[/compact]` for slash command, `[ConversationHistorySummarizer]` for auto-compaction |
| **Chat Debugger** | `summarizeConversationHistory-full` or `summarizeConversationHistory-simple` entries |
| **Disk (on failure)** | `~/compaction_failed_*.json` — full request body for reproduction |

## Architecture

```
Any model (Opus 4.6, Codex, GPT-5.4, ...)
  └── ConversationHistorySummarizer (client-side orchestration)
       └── resolveCompactionEndpoint()
            └── DirectCompactionEndpoint → Fireworks API
                 └── accounts/msft/deployments/ihfptseo (Qwen, 262k context)
```

All server-side compaction paths are disabled:
- ❌ Anthropic `compact-2026-01-12` beta
- ❌ Responses API truncation
- ❌ `isResponsesCompactionContextManagementEnabled`

## VSIX Version History

All versions built from branch `shiyunxu/fireworks-compaction-v0.49.14` on top of `ryangabriel/custom_trajectory_compaction_model`.

| Version | Date | Size | Key Changes | Status |
|---------|------|------|-------------|--------|
| **0.49.0** | May 20 | 13MB | Initial: force Fireworks compaction for all models, disable Anthropic/Responses API paths, add logging, add retry, fix max_prompt_tokens (260K→250K) | Base build; `/compact` works but not visible in Chat Debugger |
| **0.49.1–0.49.5** | May 20 | 13MB | Iterating on `/compact` slash command: removed raw `fetch()`, routed through SDK pipeline (`makeChatRequest2`), added `[/compact]` logging | `/compact` uses SDK but still missing from Debugger |
| **0.49.6–0.49.7** | May 20 | 13MB | Added `CapturingToken` wrapper to `/compact` handler; Chat Debugger now shows compaction requests/responses | Both `/compact` and auto-compaction visible in Debugger |
| **0.49.8–0.49.14** | May 21 | 20MB | Compiled with sourcemaps + node_modules bundled (size jump); iterating on orphaned tool_call stripping, Gemini validation, background summarizer fixes | Fully functional but bloated VSIX |
| **0.49.15** | May 21 | 13MB | Cleaned build: removed sourcemaps from VSIX, kept dist-only packaging. Auto-compaction appears in Chat Debugger (`summarizeConversationHistory-full/simple`) | Clean build, all features working |
| **0.49.16** | May 22 | 13MB | Strip `image_url` content parts from Fireworks requests (Qwen doesn't support vision); images replaced with empty content | Fix: Qwen crashes on image_url parts |
| **0.49.17** | May 22 | 13MB | Replace `image_url` parts with `[User shared an image]` text placeholder instead of stripping entirely. Preserves the fact that an image was shared in the summary | **Latest stable.** Fix: summary knows images existed |

### Key Features by Version

| Feature | First Version | File |
|---------|--------------|------|
| Force all models → Fireworks Qwen | 0.49.0 | `agentIntent.ts` |
| Disable Anthropic `compact-2026-01-12` | 0.49.0 | `chatEndpoint.ts` |
| `useTruncation = false` (enable BudgetExceededError) | 0.49.0 | `agentIntent.ts` |
| `max_prompt_tokens` 260K→250K | 0.49.0 | `compactionEndpoint.ts` |
| Retry on empty Fireworks response | 0.49.0 | `summarizedConversationHistory.tsx` |
| Failed request dump to `~/compaction_failed_*.json` | 0.49.0 | `summarizedConversationHistory.tsx` |
| `/compact` via SDK (not raw fetch) | 0.49.3 | `agentIntent.ts` |
| Chat Debugger visibility | 0.49.7 | `agentIntent.ts` |
| `image_url` → text placeholder | 0.49.17 | `summarizedConversationHistory.tsx` |

### Compaction Trigger Settings (current)

| Setting | Value | Source |
|---------|-------|--------|
| Background trigger threshold | ~80% token budget (jittered) | `agentIntent.ts:482-485` |
| `summarizationEnabled` | Config-driven (`SummarizeAgentConversationHistory`) | `agentIntent.ts:557` |
| `useTruncation` | `false` (hardcoded) | `agentIntent.ts:554` |
| `max_prompt_tokens` | 250,000 | `compactionEndpoint.ts:80` |
| `max_output_tokens` | 8,192 (default) | `compactionEndpoint.ts:81` |
| Foreground trigger | `BudgetExceededError` from prompt-tsx | `agentIntent.ts:729` |
| Background trigger | `shouldKickOffBackgroundSummarization(postRenderRatio, cacheWarm, rng)` | `agentIntent.ts:836` |
