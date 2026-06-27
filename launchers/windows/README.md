# Windows launchers

Per-agent `.bat` wrappers that start the agentchattr server (if not already running) and launch an agent CLI under `python wrapper.py`. Companion shell scripts live in `../macos-linux/`.

When invoked through a project wrapper (`project-template/start_<agent>.cmd`), the chain is:

```
PowerShell -> start_<agent>.cmd -> call launchers/windows/start_<agent>.bat
```

This `call` chain is sensitive to a few cmd.exe parser quirks. **Read the rules below before adding or editing files in this directory.**

## Rules

### 1. `.bat` and `.cmd` must use CRLF line endings

`cmd.exe` mis-parses LF-only batch files when they are invoked via `call` from another `.cmd`. The symptom is spurious `'M' is not recognized as an internal or external command` noise; in some configurations it cascades into `not was unexpected at this time` and aborts the run before `activate.bat` finishes.

`.gitattributes` enforces this with `*.bat text eol=crlf` and `*.cmd text eol=crlf`. Make sure your editor honors `.gitattributes`, or save with CRLF explicitly.

### 2. Inside `if (...)` blocks, avoid batch metacharacters in `echo` and `REM`

cmd's paren counter and tokenizer scan the body of an `if (...)` block to find the matching `)`. They do **not** fully exempt `REM` lines or quoted strings — `(`, `)`, `&`, `|`, `^` inside `echo` or `REM` text can mis-close the block or be tokenized as command separators.

Forbidden inside `if (...)` blocks (and `for (...)`, `else (...)`, etc.):

```bat
REM (this paren-wrapped clause closes the outer if early)
REM contains & or | or ^
echo Warning: ripgrep (rg) not found
```

If you must mention these characters, place the line **outside** the block, or escape them:

```bat
echo Warning: ripgrep ^(rg^) not found      :: caret-escaped parens
```

### 3. New agent launcher checklist

When adding `launchers/windows/start_<newagent>.bat`:

- [ ] Copy from `launchers/windows/start_claude.bat` as a baseline (clean post-fix template)
- [ ] Save with CRLF line endings
- [ ] Verify no `echo` / `REM` inside any `if (...)` block contains `(`, `)`, `&`, `|`, `^` (use the lint sketch below)
- [ ] Smoke-test via the project wrapper path: from PowerShell, `cd` into a project that has `.agentchattr/`, then run `.\.agentchattr\start_<newagent>.cmd` and confirm no spurious noise before the agent banner

### Lint sketch (manual)

To check the rules above by hand:

```powershell
# Files with LF instead of CRLF (should output nothing)
Get-ChildItem launchers\windows\*.bat | ForEach-Object {
  $b = [IO.File]::ReadAllBytes($_.FullName)
  for ($i=0; $i -lt $b.Length; $i++) {
    if ($b[$i] -eq 0x0A -and ($i -eq 0 -or $b[$i-1] -ne 0x0D)) { $_.Name; break }
  }
}

# echo lines with unescaped parens (each match needs review)
Select-String -Path launchers\windows\*.bat -Pattern 'echo.*[()]' | Where-Object { $_.Line -notmatch '\^[()]' }
```

A pre-commit / CI version of these checks is tracked separately.
