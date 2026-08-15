/**
 * opencode-plugin-deepseek-v4-anchor (OpenCode port)
 * =====================================
 *
 * WHAT THIS IS
 * ------------
 * A single-file OpenCode v1 plugin that ports the "Anchored Standard" preset
 * from `xiaobright/dsh-anchored-standard` (a DeepSeek Harness / DSH agent
 * preset for Claude-Code-style tools). It only activates for requests whose
 * model id starts with `deepseek-v4-` (see MODEL_PREFIX below); every other
 * model is completely untouched by this plugin.
 *
 * UPSTREAM EXPERIMENTAL STATUS - READ BEFORE TRUSTING THE NUMBERS
 * -----------------------------------------------------------------
 * Upstream's observation is that DeepSeek V4 Pro picks its reasoning
 * trajectory for the *whole session* based on the shape of the very first
 * API request. Their Minimal preset scores 99/96 on a "Project2" benchmark;
 * full Standard/PTC only gets 91/92, but staying on Minimal forever gives up
 * Standard's full tool surface for the rest of the conversation. Anchored
 * Standard's trick is to disguise request #1 as Minimal, then restore full
 * capability from request #2 onward. Upstream reports 98/99 on two runs of
 * V4 Pro with reasoningEffort=max.
 *
 * That 98/99 was measured on DSH + a project called "Project2" on Windows.
 * It is NOT a promise that this port improves (or even affects) any
 * workload on OpenCode. Whether it helps here is something the user has to
 * measure themselves by comparing runs with DSH_ANCHOR_DISABLE=1 on and off.
 *
 * THE FOUR UPSTREAM LAYERS, AND WHICH ARE "ALWAYS ON" VS "REQUEST #1 ONLY"
 * -------------------------------------------------------------------------
 *   1. persona text + "complete: true" + "includeRuntimeContext: false"
 *      -> ALWAYS ON for the whole session (every request gets the minimal
 *         persona instead of the full system prompt). This is *why* the
 *         prompt-prefix cache only breaks once, at the tool-set switch --
 *         the persona itself never changes shape.
 *   2. tool catalog narrowed to bash + read
 *      -> REQUEST #1 ONLY.
 *   3. bootstrapMaxTokens (output cap)
 *      -> REQUEST #1 ONLY.
 *   4. suppressedContextSources (agent-instructions / skill-catalog)
 *      -> REQUEST #1 ONLY (folded into the same system-prompt rewrite as
 *         layer 1, since OpenCode hands us system as one already-joined
 *         string, not as separate addressable sources).
 *
 * This means layers 1+4 live in `experimental.chat.system.transform`
 * (persona swap is unconditional; instructions/skills are conditionally
 * re-added once "promoted"), and layers 2+3 live in `chat.params` (and are
 * only applied pre-promotion).
 *
 * OPENCODE PRIVATE INTERNALS THIS PLUGIN DEPENDS ON
 * ---------------------------------------------------
 * None of the following are public OpenCode contracts. They were read out
 * of the 1.18.18 bundle's embedded JS and can change on any OpenCode
 * upgrade. Each has a degrade path so a mismatch fails safe (exposes the
 * full, unmodified behavior) instead of corrupting a session:
 *
 *   - The v1 loader tries the DEFAULT export first (`mod.default.server(ctx,
 *     options)`), and only falls back to invoking every named export as its
 *     own plugin factory when there is no default export. This file
 *     therefore ships a `PluginModule` default export (`{ id, server }`) --
 *     `id` is mandatory for file-sourced plugins specifically, the loader
 *     throws without it. This was learned the hard way: an earlier revision
 *     shipped only the named `DshAnchoredStandard` export, which silently
 *     rode the undocumented named-export fallback instead of the intended
 *     path (harmless by luck, since `reorganizeSystemPrompt` doesn't throw
 *     when misapplied as a factory, but not something to depend on).
 *     Degrade: if this loader-selection logic changes shape again, the
 *     symptom would be "plugin file present and scanned, but the factory
 *     body's load-time debug line never appears in the log" -- exactly the
 *     ambiguity the DEBUG-gated "loaded" line and the file-based debug log
 *     (see below) exist to make diagnosable from outside the process.
 *
 *   - `Plugin.trigger(name, input, output)` passes `input`/`output` BY
 *     REFERENCE, with no cloning. This is what makes mutating
 *     `input.message.tools` inside `chat.params` effective at all.
 *     Degrade: if a future OpenCode starts cloning before dispatch, this
 *     plugin's tool-narrowing silently becomes a no-op (nothing throws;
 *     the full tool catalog just keeps showing up on request #1 too).
 *
 *   - Inside `LLMRequestPrep.prepare`, the tool-set filter `Wd(e)` runs
 *     AFTER `chat.params` fires, and reads `e.user.tools` (which is the
 *     exact same object OpenCode hands us as `input.message` in
 *     `chat.params`). This ordering is why writing `false` into
 *     `input.message.tools[id]` inside `chat.params` is the only available
 *     lever for per-request tool narrowing (`tool.definition` can only
 *     rewrite a tool's description/parameters, it cannot remove a tool).
 *     Degrade: if this ordering ever flips, tool narrowing stops working;
 *     nothing crashes, the model just always sees the full catalog.
 *
 *   - `SessionPrompt.run`'s main loop re-reads `{user, assistant} =
 *     Me.latest(...)` fresh on every step, so `e.user` (and therefore
 *     `input.message`) is a brand-new object every request. This is why
 *     phase transitions are naturally clean -- step 2 never inherits step
 *     1's injected `tools` object. `releaseInjected` below is pure belt-
 *     and-braces insurance for the (currently believed impossible) case of
 *     object reuse.
 *
 *   - The CURRENT step's assistant message is already persisted (via
 *     `updateMessage` -> `create` -> `process`) *before* the outbound
 *     request is even sent. This is why phase detection cannot use "does
 *     an assistant message exist for this session" -- that would already
 *     be true during request #1 itself. It must instead check for a
 *     *contentful* assistant message/part (see isPromoted below).
 *     Degrade: getting this wrong would misdetect promotion one step
 *     early, permanently defeating the anchoring; the explicit
 *     content-type filter (`text`/`tool`/`reasoning`, excluding
 *     `step-start` and friends) is what prevents that.
 *
 *   - By the time either hook sees it, `system` has already been joined
 *     into a SINGLE string:
 *     `[...agent.prompt, ...e.system, ...e.user.system].filter(Boolean).join("\n")`.
 *     There is no array-index access to individual sources anymore, only
 *     string content. All context stripping here is therefore done by
 *     locating known literal anchors inside that string, never by index.
 *     Degrade: if an anchor's literal text ever changes upstream, the
 *     specific segment search silently stops matching and that segment is
 *     folded into whatever comes after it (see point 5 below), or --  for
 *     the load-bearing `<env>` anchor specifically -- the whole hook
 *     becomes a no-op for that request (see the `chat.system.transform`
 *     hook's guard clause).
 *
 *   - `experimental.chat.system.transform`'s `output` is a THROWAWAY OBJECT
 *     LITERAL, and its write-back semantics do NOT match `chat.params`'.
 *     The caller does roughly:
 *       let l = [...].filter(Boolean).join("\n")] // real array it keeps using
 *       yield* trigger("experimental.chat.system.transform",
 *                       { sessionID, model }, { system: l })
 *       // ...caller goes on to use `l` directly; it never reads `output.system` back.
 *     `output.system[0] = x` mutates `l[0]` in place -- effective.
 *     `output.system = [x]` only repoints the throwaway `{ system: l }`
 *     object's own property to a brand-new array; `l` itself is untouched,
 *     so the rewrite is a complete, silent no-op on the wire. This is the
 *     opposite of `chat.params`, where the caller assigns the hook's
 *     *return value* (`k = yield* trigger("chat.params", ...)`) and `trigger`
 *     returns the same `output` object it was given, so property
 *     reassignment on that output *is* visible to the caller there.
 *     Discovered 2026-08-15 on a real deepseek-v4-pro session: the debug
 *     log clearly showed `system.transform: applied ... len 19504->46`
 *     (and later `19504->10677` for the promoted step), but the actual
 *     request on the wire showed no token-count change at all versus a
 *     no-plugin control session -- because the code at the time did
 *     `output.system = [result.system]` instead of mutating index 0. Fixed
 *     to `output.system[0] = result.system`; if a future change ever needs
 *     to alter the element *count* (not just content), it must use
 *     `output.system.splice(0, output.system.length, ...newItems)` on the
 *     existing array, never a bare reassignment of `output.system`.
 *     Degrade: getting this wrong again looks EXACTLY like success in the
 *     debug log (correct phase, correct anchor matches, correct computed
 *     length) while doing nothing on the wire -- which is why `applied`
 *     log lines carry a `verifyLen` read back from `output.system[0]`
 *     itself, not from the locally computed string, so the log cannot lie
 *     about whether the write landed.
 *
 * IF OPENCODE SWITCHES TO THE V2 SESSION ENGINE
 * ------------------------------------------------
 * OpenCode 1.18.18 also ships an experimental v2 plugin surface
 * (`ctx.aisdk.language(...)` wrapping a `LanguageModelV3`) that would be a
 * cleaner interception point in principle. It was rejected for this port
 * because the v1 request path (`Provider.getLanguage`) does not currently
 * route through it at all -- `opencode debug v2` returns an empty provider
 * catalog on this machine, i.e. v2 is not wired up for the user's actual
 * provider config. If OpenCode ever migrates the live session engine to v2,
 * this entire plugin (chat.params / experimental.chat.system.transform)
 * stops firing and would need to be rewritten around
 * `ctx.aisdk.language(...)` instead.
 *
 * A KNOWN, ACCEPTED DEGRADATION
 * --------------------------------
 * Segment D (the "Instructions from: ..." AGENTS.md/CLAUDE.md summaries) has
 * no explicit end-of-segment anchor of its own -- its real end is simply
 * "wherever the next known segment (MCP or skills) starts, or end of
 * string". When BOTH the MCP segment and the skills segment are absent,
 * segment D is parsed all the way to the end of the string, which would
 * also swallow the rare `user.system` tail (segment G) if one happened to
 * be present in that exact configuration. This is a known, accepted
 * degradation (matches the upstream philosophy of "never brick a session,
 * worst case is that a context filter overreaches slightly").
 */

import type { Plugin, PluginModule } from "@opencode-ai/plugin"
import { appendFileSync } from "node:fs"
import { join } from "node:path"

// ---------------------------------------------------------------------------
// Config (env-overridable)
// ---------------------------------------------------------------------------

// Bumped whenever load-bearing behavior changes, so a debug-log line can be
// matched back to the exact plugin build that produced it -- this is what
// answers "did the new file even load" without guessing.
const PLUGIN_VERSION = "1.1.0"

const ENABLED = process.env.DSH_ANCHOR_DISABLE !== "1"
const DEBUG = process.env.DSH_ANCHOR_DEBUG === "1"

const MODEL_PREFIX = process.env.DSH_ANCHOR_MODEL_PREFIX ?? "deepseek-v4-"

const BOOTSTRAP_TOOLS: string[] = ["bash", "read"]

const BOOTSTRAP_MAX_TOKENS = (() => {
  const raw = process.env.DSH_ANCHOR_MAX_TOKENS
  const n = raw !== undefined ? Number.parseInt(raw, 10) : Number.NaN
  return Number.isFinite(n) && n > 0 ? n : 1024
})()

const PERSONA =
  process.env.DSH_ANCHOR_PERSONA ?? "You are a helpful software engineer assistant."

// OpenCode's own built-in hidden agents. Their `system` arrays are either
// empty or their own dedicated prompt (never containing the `<env>` anchor
// this plugin keys off), so the anchor guard in the system-transform hook
// already protects them independently. This set additionally short-circuits
// `chat.params` for them so a runaway maxOutputTokens=1024 never truncates a
// summary/compaction response.
const SKIP_AGENTS = new Set(["title", "summary", "compaction"])

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function short(sessionID: string | undefined): string {
  if (!sessionID) return "?"
  return sessionID.slice(0, 8)
}

// Debug output goes to a FILE, not console.error/stdout. Reasoning (per
// field observation): OpenCode's TUI owns the terminal's raw screen buffer,
// so console.error from a plugin hook can be silently swallowed or can
// visually corrupt the interface -- either way it is not a trustworthy
// channel for "did this even run" diagnostics. A flat, append-only,
// timestamped log file is inspectable independently of whether the TUI ate
// the line. When DEBUG is off this path is never touched -- no stat, no
// open, nothing -- matching the "silent by default" requirement.
const DEBUG_LOG_PATH = join(process.env.TMPDIR ?? "/tmp", "dsh-anchor-debug.log")

function safeStringify(value: unknown): string {
  if (typeof value === "string") return value
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

function debugLog(...args: unknown[]): void {
  if (!DEBUG) return
  try {
    const ts = new Date().toISOString()
    const line = args.map(safeStringify).join(" ")
    appendFileSync(DEBUG_LOG_PATH, `${ts} [dsh-anchored-standard v${PLUGIN_VERSION}] ${line}\n`)
  } catch {
    // A logging failure must never take a real request down with it.
  }
}

const warned = new Set<string>()
function warnOnce(key: string, message: string): void {
  if (warned.has(key)) return
  warned.add(key)
  console.error(`[dsh-anchored-standard] ${message}`)
  debugLog("warnOnce", key, message)
}

type MinimalModel = { id?: string; api?: { id?: string } } | undefined | null

function isAnchoredModel(model: MinimalModel): boolean {
  if (!model) return false
  const id = model.id ?? ""
  const apiId = model.api?.id ?? ""
  return id.startsWith(MODEL_PREFIX) || apiId.startsWith(MODEL_PREFIX)
}

// ---------------------------------------------------------------------------
// Pure system-prompt segmentation / reorganization
// ---------------------------------------------------------------------------
//
// Exported (not just module-private) so it can be unit-tested in isolation
// without spinning up a real OpenCode client -- see the offline self-test
// referenced in the task's Done criteria.
//
// Anchor table (all literals verified against the OpenCode 1.18.18 bundle):
//
//   B  env          start: "You are powered by the model named "
//                   end:   "\n</env>"
//   C  references   start: "Project references provide additional directories that can be accessed when relevant."
//                   end:   "\n</available_references>"
//   D  instructions start: "\nInstructions from: "      (0..n blocks, treated as one span)
//                   end:   start of E, start of F, or end of string
//   E  mcp          start: "\n<mcp_instructions>"
//                   end:   "\n</mcp_instructions>"
//   F  skills       start: "Skills provide specialized instructions and workflows for specific tasks.\n"
//                           + "Use the skill tool to load a skill when a task matches its description."
//                   end:   "\n</available_skills>", or the end of a literal
//                          "No skills are currently available." line when no skills are installed
//   G  tail         whatever remains after the last recognized segment (rare `user.system`), always kept
//
// Reassembly:
//   PERSONA + (promoted ? D : "") + E + (promoted ? F : "") + G
// A/B/C are always discarded (persona replaces them outright).

// `reason` on the `changed: false` branch exists purely for diagnostics (the
// `experimental.chat.system.transform` hook logs it under DEBUG); it carries
// no behavioral meaning and every existing/future caller must keep treating
// `changed: false` as "leave the original system string untouched."
export type SystemReorganizeResult =
  | { changed: false; reason: string }
  | { changed: true; system: string }

const ENV_START = "You are powered by the model named "
const ENV_END = "\n</env>"
const REF_START =
  "Project references provide additional directories that can be accessed when relevant."
const REF_END = "\n</available_references>"
const D_ANCHOR = "\nInstructions from: "
const E_START_ANCHOR = "\n<mcp_instructions>"
const E_END = "\n</mcp_instructions>"
const F_START_ANCHOR =
  "Skills provide specialized instructions and workflows for specific tasks.\n" +
  "Use the skill tool to load a skill when a task matches its description."
const F_END_TAG = "\n</available_skills>"
const F_NO_SKILLS = "No skills are currently available."

export function reorganizeSystemPrompt(input: string, promoted: boolean): SystemReorganizeResult {
  try {
    // Segment B (env) is the load-bearing anchor: if it's missing this is
    // not a real agent turn (title/summary/compaction, or a future OpenCode
    // shape we don't understand) -- leave everything untouched.
    const idxEnvStart = input.indexOf(ENV_START)
    if (idxEnvStart === -1) return { changed: false, reason: "env start anchor not found" }
    const idxEnvEndAnchor = input.indexOf(ENV_END, idxEnvStart)
    if (idxEnvEndAnchor === -1) return { changed: false, reason: "env end anchor not found after start" }
    let cursor = idxEnvEndAnchor + ENV_END.length

    // Segment C (references, optional, always discarded).
    const idxRefStart = input.indexOf(REF_START, cursor)
    if (idxRefStart !== -1) {
      const idxRefEnd = input.indexOf(REF_END, idxRefStart)
      if (idxRefEnd !== -1) {
        cursor = idxRefEnd + REF_END.length
      }
      // If there's no closing anchor, don't trust the match -- leave cursor
      // where it was and let D/E/F search from there instead.
    }

    // Locate D / E / F starts from cursor onward.
    const rawD = input.indexOf(D_ANCHOR, cursor)
    const rawE = input.indexOf(E_START_ANCHOR, cursor)
    const rawF = input.indexOf(F_START_ANCHOR, cursor)

    // Segment D: from just past its own leading "\n" to the raw start of
    // whichever of E/F comes next, or end of string (the accepted
    // degradation documented at the top of this file).
    let dText = ""
    let dRawEnd = -1
    if (rawD !== -1) {
      const candidates = [rawE, rawF].filter((p) => p !== -1 && p > rawD)
      dRawEnd = candidates.length > 0 ? Math.min(...candidates) : input.length
      dText = input.slice(rawD + 1, dRawEnd)
    }

    // Segment E (mcp, optional, always kept).
    let eText = ""
    let eRawEnd = -1
    if (rawE !== -1) {
      const idxEEnd = input.indexOf(E_END, rawE)
      if (idxEEnd !== -1) {
        eRawEnd = idxEEnd + E_END.length
      } else {
        eRawEnd = rawF !== -1 && rawF > rawE ? rawF : input.length
      }
      eText = input.slice(rawE + 1, eRawEnd)
    }

    // Segment F (skills, optional, gated on `promoted`).
    let fText = ""
    let fRawEnd = -1
    if (rawF !== -1) {
      const idxFTag = input.indexOf(F_END_TAG, rawF)
      if (idxFTag !== -1) {
        fRawEnd = idxFTag + F_END_TAG.length
      } else {
        const idxNoSkills = input.indexOf(F_NO_SKILLS, rawF)
        fRawEnd = idxNoSkills !== -1 ? idxNoSkills + F_NO_SKILLS.length : input.length
      }
      fText = input.slice(rawF, fRawEnd)
    }

    // Segment G: whatever is left after the last segment we actually
    // recognized, always kept verbatim.
    const lastRawEnd =
      fRawEnd !== -1 ? fRawEnd : eRawEnd !== -1 ? eRawEnd : dRawEnd !== -1 ? dRawEnd : cursor
    const tail = input.slice(lastRawEnd)

    const parts = [PERSONA, promoted ? dText : "", eText, promoted ? fText : "", tail]
    const system = parts.filter(Boolean).join("\n")
    return { changed: true, system }
  } catch (err) {
    // Any unexpected parsing failure: never touch the original context.
    const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err)
    return { changed: false, reason: `internal exception: ${message}` }
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export const DshAnchoredStandard: Plugin = async ({ client, directory }) => {
  // Loud (file-logged, DEBUG-gated) proof of life. Emitted before anything
  // else in the factory body: if `dsh-anchor-debug.log` never gets this
  // line after a restart with DSH_ANCHOR_DEBUG=1, the plugin factory was
  // never invoked at all -- i.e. the loader problem, not a hook-logic
  // problem. If it IS there, every hook's fail-open branches below are now
  // individually observable, so "loaded but silently no-op" and "not
  // loaded" are no longer indistinguishable from the outside.
  debugLog(
    "loaded",
    `directory=${directory}`,
    `ENABLED=${ENABLED}`,
    `MODEL_PREFIX=${MODEL_PREFIX}`,
    `BOOTSTRAP_TOOLS=[${BOOTSTRAP_TOOLS.join(",")}]`,
    `BOOTSTRAP_MAX_TOKENS=${BOOTSTRAP_MAX_TOKENS}`,
    `SKIP_AGENTS=[${[...SKIP_AGENTS].join(",")}]`,
  )

  // Phase memory: once a session is observed to be promoted it stays
  // promoted for the lifetime of this process (promotion never reverses).
  const promoted = new Set<string>()

  // Which tool-deny keys this plugin injected into which message ids, so
  // `releaseInjected` can clean them back out once promoted. Cheap
  // insurance against the (currently believed impossible) case of a
  // `message` object being reused across steps.
  const injectedByMessage = new Map<string, string[]>()

  // `client.tool.ids()` cache: MCP tools can register after startup, so we
  // don't want a single early empty/short answer to be trusted forever, but
  // we also don't want to hit the local HTTP server on every single request.
  const TOOL_IDS_TTL_MS = 30_000
  let toolIdsCache: { ids: string[]; at: number } | null = null

  async function getToolIds(): Promise<string[]> {
    const now = Date.now()
    if (toolIdsCache && now - toolIdsCache.at < TOOL_IDS_TTL_MS) return toolIdsCache.ids
    try {
      const res = await client.tool.ids({ query: { directory } })
      const dataIsArray = Array.isArray(res?.data)
      const ids = dataIsArray ? (res.data as string[]) : []
      if (!dataIsArray) {
        debugLog(
          "getToolIds: non-array response from client.tool.ids()",
          `typeof data=${typeof res?.data}`,
          `res keys=[${Object.keys((res as object) ?? {}).join(",")}]`,
        )
      }
      toolIdsCache = { ids, at: now }
      return ids
    } catch (err) {
      // Fall back to a stale cache if we have one; otherwise report "no
      // tools known", which makes the bootstrap-tools-missing check below
      // trip and safely skip narrowing rather than deny everything.
      const name = err instanceof Error ? err.name : typeof err
      const message = err instanceof Error ? err.message : String(err)
      debugLog(
        "getToolIds: exception calling client.tool.ids()",
        `name=${name}`,
        `message=${message}`,
        `staleCacheSize=${toolIdsCache?.ids.length ?? 0}`,
      )
      return toolIdsCache?.ids ?? []
    }
  }

  function hasContentfulAssistantPart(part: { type?: string } | null | undefined): boolean {
    if (!part) return false
    return part.type === "text" || part.type === "tool" || part.type === "reasoning"
  }

  async function isPromoted(sessionID: string): Promise<boolean> {
    if (promoted.has(sessionID)) return true
    try {
      const res = await client.session.messages({
        path: { id: sessionID },
        query: { directory },
      })
      const msgs = res?.data
      if (!Array.isArray(msgs)) {
        // No data back -> fail open, never brick. This is the branch the
        // coordinator most suspects is silently tripping on every request
        // (which would explain a session that is never seen as bootstrap
        // NOR as correctly promoted -- it would just always read as
        // "promoted" from request #1 onward, exposing the full catalog
        // immediately and making the anchoring a permanent no-op).
        debugLog(
          "isPromoted: non-array response from client.session.messages(), failing OPEN (promoted=true)",
          short(sessionID),
          `typeof data=${typeof msgs}`,
          `res keys=[${Object.keys((res as object) ?? {}).join(",")}]`,
        )
        return true
      }

      let assistantCount = 0
      const hit = msgs.some((m: any) => {
        if (!m || m.info?.role !== "assistant") return false
        assistantCount++
        if (m.info?.time?.completed !== undefined) return true
        const parts = Array.isArray(m.parts) ? m.parts : []
        return parts.some((p: any) => hasContentfulAssistantPart(p))
      })

      if (hit) promoted.add(sessionID)
      debugLog(
        "isPromoted: scan result",
        short(sessionID),
        `hit=${hit}`,
        `assistantMessagesSeenBeforeDecision=${assistantCount}`,
        `totalMessages=${msgs.length}`,
      )
      return hit
    } catch (err) {
      // Scan failed entirely: never brick the session -- expose the full
      // catalog/context rather than guess wrong in the restrictive
      // direction. Deliberately NOT cached into `promoted`, so a transient
      // failure gets retried on the next request instead of sticking.
      // The coordinator's other top suspect: log the REAL exception,
      // since a swallowed error here is indistinguishable from "correctly
      // detected promoted" from outside this function.
      const name = err instanceof Error ? err.name : typeof err
      const message = err instanceof Error ? err.message : String(err)
      debugLog(
        "isPromoted: exception calling client.session.messages(), failing OPEN (promoted=true)",
        short(sessionID),
        `name=${name}`,
        `message=${message}`,
      )
      return true
    }
  }

  function releaseInjected(msg: { id?: string; tools?: Record<string, boolean> }): void {
    if (!msg?.id) return
    const keys = injectedByMessage.get(msg.id)
    if (!keys || !msg.tools) {
      injectedByMessage.delete(msg.id)
      return
    }
    for (const k of keys) {
      if (msg.tools[k] === false) delete msg.tools[k]
    }
    injectedByMessage.delete(msg.id)
  }

  return {
    "chat.params": async (input, output) => {
      if (!ENABLED) return
      if (!isAnchoredModel(input.model)) return
      if (SKIP_AGENTS.has(input.agent)) return
      if (!input.sessionID) return

      const msg = input.message as unknown as { id?: string; tools?: Record<string, boolean> }

      const already = await isPromoted(input.sessionID)
      if (already) {
        releaseInjected(msg)
        if (DEBUG) {
          // Only pay for the extra `tool.ids()` round trip (cached, so
          // usually free) when someone is actually watching the log --
          // this is the hard evidence line: it shows exactly which tools
          // were left callable for this request, phase-tagged, so a
          // "did narrowing actually happen" question never again requires
          // digging through opencode.db to find out which tool request #1
          // actually called.
          const ids = await getToolIds()
          debugLog(
            "chat.params",
            short(input.sessionID),
            input.agent,
            input.model.id,
            "phase=promoted",
            "deniedTools=0",
            `keptTools=full(${ids.length}):[${ids.join(",")}]`,
          )
        }
        return
      }

      const ids = await getToolIds()
      const missing = BOOTSTRAP_TOOLS.filter((t) => !ids.includes(t))
      let deniedCount = 0
      let keptTools: string[] = ids
      if (missing.length > 0) {
        warnOnce(
          "missing-bootstrap-tools",
          `bootstrap tools missing from client.tool.ids() (${missing.join(", ")}); ` +
            "skipping tool narrowing for this and future requests, exposing full toolset",
        )
        keptTools = ids // narrowing skipped -> everything stays callable
      } else {
        const deny: Record<string, boolean> = {}
        for (const id of ids) {
          if (!BOOTSTRAP_TOOLS.includes(id)) deny[id] = false
        }
        // Deny goes last: an explicit `false` the user already set is
        // preserved (same value either way), and a denied tool can never be
        // re-enabled by whatever was already on `msg.tools`.
        msg.tools = { ...(msg.tools ?? {}), ...deny }
        if (msg.id) injectedByMessage.set(msg.id, Object.keys(deny))
        deniedCount = Object.keys(deny).length
        keptTools = BOOTSTRAP_TOOLS.filter((t) => ids.includes(t))
      }

      output.maxOutputTokens = BOOTSTRAP_MAX_TOKENS

      debugLog(
        "chat.params",
        short(input.sessionID),
        input.agent,
        input.model.id,
        "phase=bootstrap",
        `deniedTools=${deniedCount}`,
        `keptTools=[${keptTools.join(",")}]`,
        `maxOutputTokens=${BOOTSTRAP_MAX_TOKENS}`,
      )
    },

    "experimental.chat.system.transform": async (input, output) => {
      try {
        if (!ENABLED) return
        if (!input.sessionID) {
          debugLog("system.transform: skip, no sessionID (likely Agent.generate path)")
          return
        }
        if (!isAnchoredModel(input.model)) {
          debugLog("system.transform: skip, not an anchored model", short(input.sessionID), input.model?.id)
          return
        }
        if (!Array.isArray(output.system) || output.system.length !== 1) {
          debugLog(
            "system.transform: skip, system array shape unexpected",
            short(input.sessionID),
            `isArray=${Array.isArray(output.system)}`,
            `length=${Array.isArray(output.system) ? output.system.length : "n/a"}`,
          )
          return
        }
        if (typeof output.system[0] !== "string") {
          debugLog(
            "system.transform: skip, system[0] is not a string",
            short(input.sessionID),
            `typeof=${typeof output.system[0]}`,
          )
          return
        }

        const before = output.system[0]
        const already = await isPromoted(input.sessionID)
        const result = reorganizeSystemPrompt(before, already)
        if (!result.changed) {
          debugLog(
            "system.transform: skip, reorganizeSystemPrompt declined",
            short(input.sessionID),
            result.reason,
            `phase=${already ? "promoted" : "bootstrap"}`,
            `system[0] head(80)="${before.slice(0, 80).replace(/\n/g, "\\n")}"`,
          )
          return
        }

        // MUST mutate the array element in place, never reassign
        // `output.system` itself. See the "OPENCODE PRIVATE INTERNALS" header
        // comment, point 7: OpenCode's caller passes a throwaway object
        // literal (`{ system: l }`) as `output` and afterwards only ever
        // reads its own local `l` array -- it never reads `output.system`
        // back out. `output.system[0] = x` mutates that same `l[0]` in
        // place (effective); `output.system = [x]` only repoints the
        // throwaway object's property to a new array and leaves the
        // caller's `l` untouched (silently a complete no-op). This exact
        // mistake shipped once already: the debug log claimed 19504->46
        // chars while the real request on the wire was unchanged.
        output.system[0] = result.system

        // Read the value back out of `output.system[0]` (not out of
        // `result.system`) so this line is proof the in-place write
        // actually landed, not just that `reorganizeSystemPrompt` computed
        // something -- the whole point of `verifyLen` is to make a future
        // "log says X, wire says Y" regression impossible to miss again.
        debugLog(
          "system.transform: applied",
          short(input.sessionID),
          input.model.id,
          `phase=${already ? "promoted" : "bootstrap"}`,
          `len ${before.length}->${result.system.length}`,
          `verifyLen=${output.system[0].length}`,
        )
      } catch (err) {
        // Never let a parsing bug eat the user's context: leave output
        // exactly as OpenCode built it. Still log what happened, since a
        // swallowed exception here is exactly the kind of thing that would
        // masquerade as "plugin loaded but every hook silently no-ops."
        const name = err instanceof Error ? err.name : typeof err
        const message = err instanceof Error ? err.message : String(err)
        debugLog(
          "system.transform: exception, leaving output untouched",
          short(input.sessionID),
          `name=${name}`,
          `message=${message}`,
        )
      }
    },

    event: async (input) => {
      try {
        if (!ENABLED) return
        const evt = input.event as any
        if (!evt) return

        if (evt.type === "message.updated") {
          const info = evt.properties?.info
          if (info?.role === "assistant" && info?.time?.completed !== undefined && info?.sessionID) {
            promoted.add(info.sessionID)
            debugLog("event: promoted via message.updated", short(info.sessionID))
          }
          return
        }

        if (evt.type === "message.part.updated") {
          const part = evt.properties?.part
          // `tool` and `reasoning` parts are structurally assistant-only
          // (unlike `text`, which is shared with user messages), so this is
          // safe without cross-checking message role. Text parts are
          // intentionally left to the persistent `isPromoted` scan, which
          // does check role explicitly.
          if (part && (part.type === "tool" || part.type === "reasoning") && part.sessionID) {
            promoted.add(part.sessionID)
            debugLog("event: promoted via part", part.type, short(part.sessionID))
          }
        }
      } catch {
        // An event-hook bug must never affect session processing.
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Default export: PluginModule, not a bare factory function
// ---------------------------------------------------------------------------
//
// OpenCode's v1 loader (`mk` in the bundle) tries the default export first:
//   let Y = lookup(mod, spec, "server", "detect")   // reads mod.default
//   if (Y) { hooks.push(await Y.server(ctx, options)); return }
//   for (const fn of Object.values(mod)) hooks.push(fn)   // <- fallback
//
// Without a default export, `mod.default` is `undefined`, so the loader
// falls through to the second branch, which invokes *every* named export as
// if it were its own plugin factory -- including `reorganizeSystemPrompt`,
// a pure string function that happens not to throw when called with a
// nonsense `(pluginInput, options)` pair; it just returns `{changed:false,
// reason: ...}`, which then gets silently pushed into the hooks array as a
// garbage entry (harmless today only because none of its keys match a real
// hook name, but is an undocumented, load-bearing accident to rely on).
//
// Also, for `source === "file"` plugins specifically, the loader requires
// the default-export path to yield an `id` -- `if (!id) throw new TypeError(
// "Path plugin ${spec} must export id")` -- so `id` is not optional here.
//
// `DshAnchoredStandard` stays as a named export too (backward compatible,
// and it's what the offline self-test / any future test harness imports
// directly without going through the loader at all).
const dshAnchoredStandardModule: PluginModule = {
  id: "deepseek-v4-anchor",
  server: DshAnchoredStandard,
}

export default dshAnchoredStandardModule
