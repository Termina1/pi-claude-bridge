/** Fork/resume provider prompts can be replayed from a different session than
 * ctx.getSystemPrompt(). Structured sections, not current resource options, own
 * the instructions sent on that request. Never parse opaque prompt text. */
import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { getCurrentSystemMessage } from "@earendil-works/pi-ai";
import activate, { __test } from "../src/index.js";
import { PI_PREAMBLE, PromptCaptures, projectPromptCapture } from "../src/prompt-capture.js";
import { toBridgeContext } from "../src/transcript.js";

const OLD_DEFAULT = `${PI_PREAMBLE}, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.`;
const DEFAULT = "You are a coding assistant running inside pi, a coding agent harness. Help users inspect files, run commands, and modify code.";
const system = (sections, content = "") => ({ role: "system", content, sections, timestamp: 0 });
const user = (content) => ({ role: "user", content, timestamp: 1 });
const block = (name, content) => `<${name}>\n${content}\n</${name}>`;
const parentSections = {
	preamble: OLD_DEFAULT,
	tools: block("tools", "PI TOOL HARNESS"),
	rules: block("rules", "PI RULE HARNESS"),
	docs: block("docs", "docs/custom-provider.md and docs/packages.md"),
	addendum: block("addendum", "parent appended policy"),
	project_context: block("project_context", "<project_instructions path=\"/parent/AGENTS.md\">\nparent policy\n</project_instructions>"),
	skills: block("skills", "Use the read tool to load a skill's file\n<available_skills>parent skill catalog</available_skills>"),
	cwd: block("cwd", "/parent"),
};
// A later parent patch changes the preamble and skill catalog. The child has
// its own final patch on disk, but projectForkRequest removes it from the
// provider request and moves child instructions to the task's user message.
const parent = [system(parentSections), system({ preamble: DEFAULT, skills: block("skills", "Use the read tool to load a skill's file\nupdated parent skill catalog") })];
const childPatch = system({
	preamble: "child role", project_context: block("project_context", "child policy"),
	tools: null, rules: null, docs: null, addendum: null, skills: null,
});
const childRecordedPrompt = toBridgeContext({ messages: [...parent, childPatch] }).systemPrompt;
const forkRequest = [...parent, user("<subagent_instructions>child task policy</subagent_instructions>\nDo the task")];

function resolve(captures, messages) {
	return captures.resolveOrDerive(toBridgeContext({ messages }).systemPrompt, getCurrentSystemMessage(messages));
}
function project(capture, skillReadTool = "mcp") {
	return projectPromptCapture(capture, { skillReadTool });
}

afterEach(() => {
	__test.setQuery(null);
	__test.resetSharedSession();
});

describe("transcript-derived prompt capture", () => {
	it("projects the fork's parent-only replay, not the child prompt recorded by hooks", () => {
		const captures = new PromptCaptures();
		captures.record(childRecordedPrompt, { custom: "child role", contextFiles: [{ path: "/child/AGENTS.md", content: "child policy" }], skills: [] }, "turn_start");
		const requestPrompt = toBridgeContext({ messages: forkRequest }).systemPrompt;
		assert.notEqual(requestPrompt, childRecordedPrompt);
		const captured = resolve(captures, forkRequest);
		assert.equal(captured.source, "provider_transcript");
		const append = project(captured);
		assert.match(append, /parent policy/);
		assert.match(append, /parent appended policy/);
		assert.match(append, /updated parent skill catalog/);
		assert.match(append, /mcp__custom-tools__read/);
		assert.doesNotMatch(append, /child policy|child role|PI TOOL HARNESS|PI RULE HARNESS|docs\/|<cwd>|operating inside pi|running inside pi/);
		assert.equal(toBridgeContext({ messages: forkRequest }).messages[0].content, forkRequest.at(-1).content, "child instructions stay in the user task unchanged");
	});

	it("recovers a resumed prompt with no process-local captures, including raw content and custom sections", () => {
		const messages = [system({ ...parentSections, preamble: "custom operator role", mcp_servers: block("mcp_servers", "extension policy") }, "extra system instruction")];
		const append = project(resolve(new PromptCaptures(), messages));
		for (const text of ["extra system instruction", "custom operator role", "parent policy", "parent appended policy", "parent skill catalog", block("mcp_servers", "extension policy")]) {
			assert.ok(append.includes(text), `missing ${text}`);
		}
		assert.doesNotMatch(append, /PI TOOL HARNESS|PI RULE HARNESS|docs\/|<cwd>/);
		assert.equal(append.split("<mcp_servers>").length - 1, 1, "rendered sections are not wrapped twice");
	});

	it("keeps exact captures authoritative instead of replacing their portable parts", () => {
		const captures = new PromptCaptures();
		const prompt = toBridgeContext({ messages: parent }).systemPrompt;
		captures.record(prompt, { custom: "authoritative capture", contextFiles: [], skills: [] }, "agent_start");
		assert.equal(project(resolve(captures, parent)), "authoritative capture");
		assert.equal(captures.resolve(prompt).source, "agent_start");
	});

	it("tries embedded captures before structural fallback and preserves the wrapper", () => {
		const captures = new PromptCaptures();
		captures.record("known assembled prompt", { custom: "known portable policy", contextFiles: [], skills: [] });
		const messages = [system({ preamble: "PREFIX known assembled prompt SUFFIX" })];
		assert.equal(project(resolve(captures, messages)), "PREFIX known portable policy SUFFIX");
		assert.equal(captures.size, 1, "embedded derivations remain transient");
	});

	it("does not parse an opaque prompt or accept unrelated transcript evidence", () => {
		const captures = new PromptCaptures();
		assert.throws(() => resolve(captures, [system(undefined, "opaque <project_context>policy</project_context>")]), /prompt-capture: no capture/);
		assert.throws(() => captures.resolveOrDerive("different request", getCurrentSystemMessage(parent)), /prompt-capture: no capture/);
		assert.throws(() => resolve(captures, [system({}, "opaque")]), /prompt-capture: no capture/);
	});

	it("recognizes only exact default preambles and still guards every forwarded section", () => {
		for (const preamble of [OLD_DEFAULT, DEFAULT]) {
			assert.doesNotMatch(project(resolve(new PromptCaptures(), [system({ ...parentSections, preamble })])), /operating inside pi|running inside pi/);
			assert.throws(() => project(resolve(new PromptCaptures(), [system({ ...parentSections, preamble: `${preamble}\nunknown additions` })])), /refusing to send this prompt/);
		}
		for (const name of ["project_context", "skills", "addendum", "some_extension"]) {
			assert.throws(() => project(resolve(new PromptCaptures(), [system({ ...parentSections, [name]: block(name, "docs/custom-provider.md and docs/packages.md") })])), /refusing to send this prompt/);
		}
		assert.throws(() => project(resolve(new PromptCaptures(), [system(parentSections, `${PI_PREAMBLE}, unknown harness`)])), /refusing to send this prompt/);
	});

	it("uses the existing skill-reader policy on replayed skill catalogs", () => {
		const capture = resolve(new PromptCaptures(), parent);
		assert.match(project(capture, "native"), /Use the read tool to load/);
		assert.doesNotMatch(project(capture, "native"), /mcp__custom-tools__read/);
		assert.doesNotMatch(project(capture, "none"), /skill catalog|<skills>/);
	});

	it("the actual provider boundary supplies the replayed transcript to the resolver", async () => {
		let provider;
		activate({ on: () => {}, registerProvider: (_name, config) => { provider = config; }, registerTool: () => {} });
		let options;
		__test.setQuery((params) => { options = params.options; throw new Error("offline query sentinel"); });
		const messages = [...forkRequest];
		// A declared reader makes the bridge forward the replayed skills catalog.
		messages.unshift(system(undefined));
		messages[0].toolsAdded = [{ name: "read", description: "read", parameters: { type: "object", properties: {} } }];
		const result = await provider.streamSimple(provider.models[0], { messages }, { sessionId: "transcript-fork-regression" }).result();
		assert.match(result.errorMessage, /offline query sentinel/);
		assert.ok(options, "the request passed prompt resolution and reached the SDK stub");
		assert.match(options.systemPrompt.append, /parent policy/);
		assert.match(options.systemPrompt.append, /parent appended policy/);
		assert.match(options.systemPrompt.append, /updated parent skill catalog/);
		assert.doesNotMatch(options.systemPrompt.append, /docs\/|PI TOOL HARNESS|PI RULE HARNESS|operating inside pi|running inside pi/);
	});
});
