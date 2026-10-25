// 占位实现：Task 4 会替换为真正的 applet 检查器
const cmd = process.argv[2];

if (cmd !== 'applets') {
  console.error(`usage: tsx platform/worker/checker/cli.ts applets (got: ${cmd ?? '<none>'})`);
  process.exit(1);
}

console.log(JSON.stringify({ issues: [] }));
