/** `ps` flags that print a process's environment after its command line: BSD/macOS `-E`, procps
 *  (Linux) the BSD-style `e` (procps rejects `-E`). Only the caller's own processes show it. */
export const PS_ENV: readonly string[] = process.platform === "linux" ? ["e"] : ["-E"];

/** `ps -axE` for every process: procps spells it `axe` (its `-x` needs a BSD personality). */
export const PS_ALL_ENV: readonly string[] = process.platform === "linux" ? ["axe"] : ["-axE"];
