# Validation Findings: Multi-Provider Agent Runner Abstraction

**Date**: 2026-03-15
**Status**: Validated & Reviewed

This document summarizes the validation of the [Multi-Provider Agent Runner Abstraction Spec](/Users/ivo.toby/Documents/cf-notes/specs/2026-03-14-multi-provider-agent-runner.md). The spec is fundamentally sound, but requires minor technical adjustments for the Codex CLI implementation.

---

## 1. Overall Approach Assessment
The proposed architecture is **highly effective** and aligns with the project's goal of provider-agnostic execution.

*   **Execution Strategy Split**: The distinction between `SDKExecutionStrategy` (streaming/sessions) and `CLIExecutionStrategy` (batch/stateless) is the correct abstraction. It preserves Claude's performance advantages while enabling other providers.
*   **Context Normalization**: The "Context Usage Ratio" (0.0–1.0) successfully solves the metric mismatch between Claude's `cache_read_input_tokens` and other providers' `input_tokens`.
*   **Continuity Mechanism**: Reusing `ContextAssembler` for stateless providers (Gemini/Codex) is efficient and ensures functional parity across backends.

## 2. Priority & Roadmap
The 4-phase plan is **logical and safe**:
*   **Phase 1 (Refactor)**: Ensuring the existing Claude path works under the new abstraction before adding binaries is a best-practice approach.
*   **Background Agents First**: Correctly identifies these as lower-risk entry points for testing translation logic.
*   **Phase 4 (Failover)**: Properly deferred, as it introduces complex UX challenges (context loss notifications) that should only be tackled on a stable multi-provider foundation.

## 3. Technical Adjustments & Corrections

### 3.1 Gemini CLI
*   **Status**: **Verified**.
*   **Findings**: Flags (`--prompt`, `--output-format json`, `--yolo`, `--non-interactive`) and config format (`.gemini/settings.json` with `mcpServers`) are accurate. Usage data is under `stats.perModel`.

### 3.2 Codex CLI
*   **Status**: **Adjustments Required**.
*   **Finding 1 (Approval Modes)**: The spec proposes `--approval-mode never`. In Codex, `never` typically blocks all side-effects (read-only). To allow task execution (file edits/commands), use **`--full-auto`** or **`--approval-mode auto-edit`**.
*   **Finding 2 (MCP Config Format)**: Section 4.3 of the spec joins command and args into a single string. Codex supports an **`args` array** in `config.toml`, which is safer for paths with spaces.
    ```toml
    [mcp_servers.my-server]
    command = "npx"
    args = ["-y", "@mcp/server"]
    ```
*   **Finding 3 (Output Parsing)**: Codex outputs **JSONL (newline-delimited JSON)**, not a single JSON object.
    *   The **Agent Message** is in an event: `{"type": "item.completed", "item": {"type": "agent_message", "text": "..."}}`.
    *   The **Token Usage** is in a separate event: `{"type": "turn.completed", "usage": {"input_tokens": 1200, ...}}`.
    *   *Update Recommendation*: The `parseOutput` logic in Section 4.3 must be updated to process these events line-by-line.

## 4. Final Recommendations
1.  **Phase 1 Priority**: The `ContextRoller` refactor to use ratios should be treated as a critical "Phase 1" task to ensure cross-provider safety.
2.  **Codex Writer Update**: Update the `CodexCliProvider` to write the `args` array in TOML instead of a joined command string.
3.  **Latency Management**: For CLI-strategy providers, consider adding a "Waiting for agent..." notification to the channel to manage user expectations during long batch runs (30-60s).
