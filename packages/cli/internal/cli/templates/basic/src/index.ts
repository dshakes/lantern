import { agent, step } from "@pal-runtime/sdk";

export default agent({
  name: "{{.Name}}",
  async run({ input, ctx }) {
    const result = await step("greet", async () => {
      const response = await ctx.llm.complete({
        prompt: `Say hello to ${input.name}`,
      });
      return response;
    });

    return { greeting: result };
  },
});
