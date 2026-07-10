import { createBot } from "./bot/bot.js";

const bot = createBot();

bot.start({
  onStart: (me) => console.log(`@${me.username} up, long polling.`),
});
