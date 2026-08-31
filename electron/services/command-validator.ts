import type { PermissionLevel } from '../../shared/types'

export type Classification = { level: PermissionLevel; reason: string }

/**
 * Commands reach PowerShell as a single string, so the safety boundary is this
 * classifier plus the approval prompt — not shell quoting. Anything that cannot
 * be undone, disables a security control, or rewrites the boot/registry surface
 * is BLOCKED outright; anything destructive but legitimate needs confirmation.
 *
 * ponytail: regex classification over a curated rule table, not a shell parser.
 * A determined author can obfuscate past regexes (string concatenation, aliases,
 * base64). That is acceptable because the model is the author here and the user
 * still sees the literal command in the approval dialog. Swap in a real
 * PowerShell AST walk (System.Management.Automation.Language.Parser) if Akansha
 * ever runs commands from untrusted third parties.
 */
const RULES: { level: PermissionLevel; reason: string; test: RegExp }[] = [
  // ---- BLOCKED: unrecoverable or security-disabling -------------------------
  { level: 'BLOCKED', reason: 'formats a disk', test: /\bformat(-volume)?\b|\bdiskpart\b/i },
  {
    level: 'BLOCKED',
    reason: 'destroys shadow copies / backups',
    test: /vssadmin\s+delete|wbadmin\s+delete|\bcipher\s+\/w/i
  },
  {
    level: 'BLOCKED',
    reason: 'rewrites boot configuration',
    test: /\bbcdedit\b|\bbootrec\b|\bbootsect\b/i
  },
  {
    level: 'BLOCKED',
    reason: 'disables security software',
    test: /Set-MpPreference[^|]*-Disable|Add-MpPreference[^|]*-Exclusion|windefend|\bnetsh\s+advfirewall\s+set[^|]*\boff\b|Set-NetFirewallProfile[^|]*-Enabled\s+False/i
  },
  {
    level: 'BLOCKED',
    reason: 'wipes a drive root',
    test: /(Remove-Item|\brm\b|\brd\b|\brmdir\b|\bdel\b)[^|]*\b[a-z]:\\?\s*(\*|\\\*)?\s*(-recurse|\/s)\b|(Remove-Item|\brm\b)\s+(-r\w*\s+)?["']?[a-z]:\\["']?\s*$/i
  },
  {
    level: 'BLOCKED',
    reason: 'downloads and executes remote code',
    test: /(Invoke-WebRequest|iwr|curl|wget|Invoke-RestMethod|irm)[^|]*\|\s*(iex|Invoke-Expression|bash|sh|cmd)/i
  },
  {
    level: 'BLOCKED',
    reason: 'runs an obfuscated encoded payload',
    test: /-e(nc(odedcommand)?)?\s+[A-Za-z0-9+/=]{40,}/i
  },
  {
    level: 'BLOCKED',
    reason: 'harvests stored credentials',
    test: /mimikatz|\bsekurlsa\b|lsass|Get-Credential\s*\|\s*|\bcmdkey\s+\/list\b|vaultcmd/i
  },
  {
    level: 'BLOCKED',
    reason: 'deletes a registry hive',
    test: /reg(\.exe)?\s+delete\s+HK(LM|EY_LOCAL_MACHINE)|Remove-Item[^|]*HKLM:\\(SOFTWARE|SYSTEM)\s*$/i
  },

  // ---- PRIVILEGED: needs elevation or reconfigures the machine --------------
  {
    level: 'PRIVILEGED',
    reason: 'requests administrator elevation',
    test: /-Verb\s+RunAs|\brunas\b|\bsudo\b|\bgsudo\b/i
  },
  {
    level: 'PRIVILEGED',
    reason: 'changes services, drivers or scheduled tasks',
    test: /\bsc(\.exe)?\s+(config|create|delete|stop|start)\b|(Stop|Start|Set|Restart)-Service\b|\bschtasks\b|(New|Set|Unregister)-ScheduledTask\b|\bpnputil\b|\bDism\b|\bsfc\b/i
  },
  {
    level: 'PRIVILEGED',
    reason: 'writes machine-wide registry or policy',
    test: /reg(\.exe)?\s+(add|import)\s+HK(LM|EY_LOCAL_MACHINE)|(Set|New)-ItemProperty[^|]*HKLM:|\bgpupdate\b|\bsecedit\b/i
  },
  {
    level: 'PRIVILEGED',
    reason: 'changes network configuration',
    test: /\bnetsh\b|(New|Set|Remove)-Net(IPAddress|Adapter|Route|FirewallRule)\b/i
  },
  {
    level: 'PRIVILEGED',
    reason: 'creates or changes user accounts',
    test: /\bnet\s+(user|localgroup)\b|(New|Set|Remove)-LocalUser\b|Add-LocalGroupMember\b/i
  },
  {
    level: 'PRIVILEGED',
    reason: 'powers off or restarts the machine',
    test: /\bshutdown\b|Stop-Computer\b|Restart-Computer\b/i
  },

  // ---- CONFIRM: destructive but ordinary -----------------------------------
  {
    level: 'CONFIRM',
    reason: 'deletes files',
    test: /Remove-Item\b|\bdel\b|\berase\b|\brmdir\b|\brd\b|\brm\b|Clear-Content\b|Clear-RecycleBin\b/i
  },
  {
    level: 'CONFIRM',
    reason: 'moves, renames or overwrites files',
    test: /Move-Item\b|Rename-Item\b|\bmove\b|\bren(ame)?\b|Set-Content\b|Out-File\b|\s>\s*[^|>\s]/i
  },
  {
    level: 'CONFIRM',
    reason: 'terminates processes',
    test: /\btaskkill\b|Stop-Process\b|\bkill\b/i
  },
  {
    level: 'CONFIRM',
    reason: 'rewrites git history or publishes code',
    test: /git\s+(push|reset\s+--hard|clean\s+-\w*f|checkout\s+--|rebase|filter-branch)|npm\s+(publish|unpublish)/i
  },
  {
    level: 'CONFIRM',
    reason: 'installs or removes software',
    test: /\b(npm|pnpm|yarn)\s+(i|install|uninstall|remove|add)\b|\bpip3?\s+(install|uninstall)\b|\bwinget\s+(install|uninstall|upgrade)\b|\bchoco\s+(install|uninstall)\b|\bmsiexec\b|Install-Module\b/i
  },
  {
    level: 'CONFIRM',
    reason: 'sends data to the network',
    test: /Invoke-WebRequest\b|\biwr\b|Invoke-RestMethod\b|\birm\b|\bcurl\b|\bwget\b|Send-MailMessage\b|\bftp\b|\bscp\b/i
  },
  {
    level: 'CONFIRM',
    reason: 'evaluates a dynamically built command',
    test: /Invoke-Expression\b|\biex\b|\bStart-Process\b/i
  }
]

const ORDER: PermissionLevel[] = ['SAFE', 'CONFIRM', 'PRIVILEGED', 'BLOCKED']

/** Highest-severity rule wins, so a `sudo rm -rf` is PRIVILEGED, not CONFIRM. */
export function classifyCommand(command: string): Classification {
  const cmd = String(command ?? '')
  if (!cmd.trim()) return { level: 'BLOCKED', reason: 'the command is empty' }
  if (cmd.length > 4000) return { level: 'BLOCKED', reason: 'the command is implausibly long' }
  if (cmd.includes('\0')) return { level: 'BLOCKED', reason: 'the command contains a null byte' }

  let worst: Classification = { level: 'SAFE', reason: 'read-only or inert command' }
  for (const rule of RULES) {
    if (rule.test.test(cmd) && ORDER.indexOf(rule.level) > ORDER.indexOf(worst.level)) {
      worst = { level: rule.level, reason: rule.reason }
    }
  }
  return worst
}
