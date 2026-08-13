// 一律用 execFileSync（不經 shell），參數以陣列傳入，避免任何字串拼接進命令列。
const { execFileSync } = require('child_process');

/** 回傳該埠上 LISTENING 的 PID 清單。 */
function pidsOnPort(port) {
  let out = '';
  try {
    out = execFileSync('netstat', ['-ano', '-p', 'tcp'], { encoding: 'utf8' });
  } catch {
    return [];
  }
  const pids = new Set();
  for (const line of out.split(/\r?\n/)) {
    const m = line.match(/^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$/);
    if (m && Number(m[1]) === port) pids.add(Number(m[2]));
  }
  return [...pids];
}

/** 取得 PID 的執行檔名，取不到回空字串。 */
function processName(pid) {
  try {
    const out = execFileSync('tasklist', ['/FI', `PID eq ${pid}`, '/NH', '/FO', 'CSV'], { encoding: 'utf8' });
    const m = out.match(/^"([^"]+)"/m);
    return m ? m[1] : '';
  } catch {
    return '';
  }
}

/**
 * 關閉佔用該埠的舊 node 進程。
 * 非 node 的程式不硬殺，放進 blockedBy 讓呼叫端提示使用者換埠。
 */
function freePort(port) {
  const killed = [];
  const blockedBy = [];
  for (const pid of pidsOnPort(port)) {
    if (pid === process.pid) continue;
    const name = processName(pid);
    if (/^node\.exe$/i.test(name)) {
      try {
        execFileSync('taskkill', ['/PID', String(pid), '/F'], { stdio: 'ignore' });
        killed.push(pid);
      } catch {
        blockedBy.push(`${name}(PID ${pid})`);
      }
    } else if (name) {
      blockedBy.push(`${name}(PID ${pid})`);
    }
  }
  return { killed, blockedBy };
}

module.exports = { freePort, pidsOnPort, processName };
