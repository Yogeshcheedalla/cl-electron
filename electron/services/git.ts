import { statSync } from 'node:fs'
import { truncate } from '../core/util'
import { authorize } from './guard'
import { readablePath, writablePath } from './path-guard'
import { runExe } from './shell'

const MAX_DIFF = 200_000

function repoDir(path: string, forWrite = false): string {
  const abs = forWrite ? writablePath(path) : readablePath(path)
  if (!statSync(abs).isDirectory()) throw new Error(`${abs} is not a folder.`)
  return abs
}

async function git(cwd: string, args: string[], timeoutMs = 30_000) {
  const res = await runExe('git', args, { cwd, timeoutMs })
  if (res.exitCode !== 0) {
    const detail = (res.stderr || res.stdout).trim()
    if (/not a git repository/i.test(detail)) throw new Error(`${cwd} is not a git repository.`)
    throw new Error(detail || `git ${args[0]} failed.`)
  }
  return res.stdout
}

/**
 * Read operations are free; committing asks first. There is deliberately no
 * push, no force, no reset and no history rewriting here -- if the user wants
 * those they run them in the terminal, where the command classifier shows them
 * exactly what is about to happen.
 */
export const gitService = {
  async status(repo: string): Promise<{ branch: string; files: string[]; clean: boolean }> {
    const cwd = repoDir(repo)
    const branch = (await git(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim()
    const porcelain = await git(cwd, ['status', '--porcelain'])
    const files = porcelain.split(/\r?\n/).filter(Boolean)
    return { branch, files, clean: files.length === 0 }
  },

  async diff(repo: string, staged = false): Promise<{ diff: string }> {
    const cwd = repoDir(repo)
    const out = await git(cwd, staged ? ['diff', '--staged'] : ['diff'])
    return { diff: truncate(out, MAX_DIFF) }
  },

  async log(repo: string, limit = 20): Promise<{ entries: string[] }> {
    const cwd = repoDir(repo)
    const cap = Math.min(Math.max(Number(limit) || 20, 1), 200)
    const out = await git(cwd, ['log', `-${cap}`, '--pretty=%h %ad %an: %s', '--date=short'])
    return { entries: out.split(/\r?\n/).filter(Boolean) }
  },

  async commit(repo: string, message: string, addAll = false): Promise<{ commit: string }> {
    const cwd = repoDir(repo, true)
    const msg = String(message ?? '').trim()
    if (!msg) throw new Error('A commit message is required.')

    const status = await gitService.status(cwd)
    if (status.clean) throw new Error('There is nothing to commit; the working tree is clean.')

    await authorize({
      tool: 'git.commit',
      declared: 'CONFIRM',
      summary: `Commit ${addAll ? 'all changes' : 'staged changes'} in ${cwd} as "${truncate(msg, 120)}"`,
      reason: 'Committing writes to the repository history.',
      input: { repo: cwd, message: msg, addAll, files: status.files.slice(0, 40) }
    })

    if (addAll) await git(cwd, ['add', '-A'])
    await git(cwd, ['commit', '-m', msg])
    const hash = (await git(cwd, ['rev-parse', '--short', 'HEAD'])).trim()
    return { commit: hash }
  }
}
