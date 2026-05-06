import { quickChat, globalTracker } from "./pipeline/model_client.js";

async function main() {
  const result1 = await quickChat("用一句话介绍 Python");
  console.log(`回复 1: ${result1.slice(0, 80)}`);

  const result2 = await quickChat("用一句话介绍 JavaScript");
  console.log(`回复 2: ${result2.slice(0, 80)}`);

  globalTracker.report();
}

main().catch(console.error);
