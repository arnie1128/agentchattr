# Fork remotes

本 repo 是 `agentchattr` 的個人 fork，本地設定了三個 remote，用途各異。
專案 root 的 `README.md` 是 upstream 原作版本，本文件補充 fork 自己的 remote 配置。

## 三個 remote

| Remote | URL | fetch | push | 用途 |
|---|---|---|---|---|
| `origin` | `git@personal.github:arnie1128/agentchattr.git` | ✅ | ✅ | 個人 fork：本人開發成果的推送目標 |
| `upstream` | `git@personal.github:bcurts/agentchattr.git` | ✅ | `DISABLED` | 原作者 repo：只 pull 同步，不推送 |
| `coworker` | `git@goldenf.github:gf-seanwang/agentchattr.git` | ✅ | `DISABLED` | 同事 fork：觀察與借鑑改動 |

> `personal.github` 與 `goldenf.github` 是本機 `~/.ssh/config` 設定的 Host alias，
> 對應到不同的 SSH key（個人 / 公司）。在其他機器上 clone 前需確認該機器
> 同樣有對應的 SSH alias，否則 git 連線會失敗。

## Push 保護機制

`upstream` 與 `coworker` 的 **push URL 被刻意設為 `DISABLED`**，這是安全閘，
用來防止以下誤操作：

- 不小心 `git push upstream main` 把本地改動推到原作者 repo
- 不小心 `git push coworker` 把改動推到同事的 repo

任何指向這兩個 remote 的 push 都會立即失敗（`DISABLED` 不是合法的 git URL）。
若**確實**需要推回某一邊（極少數情況），復原方式為：

```bash
git remote set-url --push upstream git@personal.github:bcurts/agentchattr.git
# 用完後務必還原成 DISABLED
git remote set-url --push upstream DISABLED
```

## 常用操作

### 一次檢查所有 remote 是否有更新

```bash
git fetch --all --dry-run
```

**注意**：不加 `--all` 的 `git fetch --dry-run` 只會查預設 upstream（通常是 `origin`），
會漏掉 `upstream` 與 `coworker` 的更新。

### 看跟某個 remote 的距離

```bash
# 輸出兩個數字：左邊 = 本地獨有 commit 數，右邊 = 對方獨有 commit 數
git rev-list --left-right --count HEAD...upstream/main
git rev-list --left-right --count HEAD...coworker/main
```

### 從 upstream 拉新版本

```bash
git fetch upstream
git merge upstream/main          # 產生 merge commit，保留 fork 自己的歷史
# 或
git rebase upstream/main         # 線性化（會改寫本地 commit hash）
```

### 觀察 coworker 的改動但不合併

```bash
git fetch coworker
git log --oneline coworker/main ^HEAD         # 列出 coworker 有、本地沒有的 commit
git show coworker/main:<file>                 # 看 coworker 某檔當前內容
git diff HEAD coworker/main -- <file>         # 與 coworker 比對單一檔案
git cherry-pick <commit-sha>                  # 挑選單一 commit 進來
```

## 三個 remote 的同步策略建議

- **`upstream` → 本地**：當原作者釋出修正或新功能，先 `fetch` 看 diff，
  再決定 `merge` 或 `rebase`。fork 已分歧太久時，merge 較安全（保留歷史，
  衝突解一次就好）。
- **`coworker` → 本地**：不直接 merge，採 cherry-pick 挑選感興趣的 commit。
  避免把同事整支歷史並進來，造成方向耦合。
- **本地 → `origin`**：日常推送目標，直接 `git push` 即可。
