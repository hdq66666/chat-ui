import { describe, expect, it, vi } from "vitest";

function fakeModel(id: string, text: string, imageGeneration = false) {
	return {
		id,
		imageGeneration,
		parameters: {},
		getEndpoint: vi.fn(
			async () => async () =>
				(async function* () {
					yield { token: { text }, generated_text: text };
				})()
		),
	};
}

const mocks = vi.hoisted(() => ({ models: [] as unknown[], taskModel: undefined as unknown }));
vi.mock("$lib/server/models", () => ({
	get models() {
		return mocks.models;
	},
	get taskModel() {
		return mocks.taskModel;
	},
}));

const { generateFromDefaultEndpoint } = await import("./generateFromDefaultEndpoint");

async function run(modelId: string) {
	const gen = generateFromDefaultEndpoint({ messages: [], modelId, locals: undefined });
	let step = await gen.next();
	while (!step.done) step = await gen.next();
	return step.value;
}

describe("generateFromDefaultEndpoint", () => {
	it("uses the task model instead of an image model, which has no chat endpoint", async () => {
		const task = fakeModel("chat", "Paper boat");
		const image = fakeModel("gpt-image-2.6-sunburst", "unused", true);
		mocks.models = [task, image];
		mocks.taskModel = task;

		expect(await run("gpt-image-2.6-sunburst")).toBe("Paper boat");
		expect(image.getEndpoint).not.toHaveBeenCalled();
	});

	it("still uses a requested chat model", async () => {
		const task = fakeModel("chat", "from task");
		const other = fakeModel("other-chat", "from other");
		mocks.models = [task, other];
		mocks.taskModel = task;

		expect(await run("other-chat")).toBe("from other");
	});
});
