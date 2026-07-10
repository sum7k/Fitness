import { extract } from "../src/llm/extract.js";

const r = await extract(
  [
    {
      type: "text",
      text: "had 2 rotis with dal for lunch, one samosa in evening, walked 8000 steps. also why is my weight stuck?",
    },
  ],
  "Thu 14:30",
);
console.log(JSON.stringify(r, null, 1));
