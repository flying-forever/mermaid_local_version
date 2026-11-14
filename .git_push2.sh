#!/usr/bin/env bash
set -u
cd "D:/WorkSpaces/gpt-root/临时/工作流图格式_20261114" || exit 1
GIT="D:/software/Git/cmd/git.exe"
HELPER="D:/software/Git/mingw64/libexec/git-core/git-credential-wincred.exe"
CA="D:/software/Git/mingw64/ssl/certs/ca-bundle.crt"
TOKEN=$(printf 'protocol=https\nhost=github.com\n\n' | "$HELPER" get | sed -n 's/^password=//p')
if [ -z "$TOKEN" ]; then echo "NO_TOKEN"; exit 2; fi
URL="https://flying-forever:${TOKEN}@github.com/flying-forever/mermaid_local_version.git"

rm -f .git_push_check.sh
"$GIT" add -A
"$GIT" -c core.quotepath=false status --short

"$GIT" commit -q -F - <<'MSG'
添加仓库根目录 README：项目定位、快速开始、目录与限制
MSG

"$GIT" -c http.sslBackend=openssl -c http.sslCAInfo="$CA" push "$URL" main 2>&1 | sed "s/${TOKEN}/REDACTED/g"

echo "--- status"
"$GIT" -c http.sslBackend=openssl -c http.sslCAInfo="$CA" fetch "$URL" "+refs/heads/main:refs/remotes/origin/main" 2>&1 | sed "s/${TOKEN}/REDACTED/g"
"$GIT" log --oneline -2
"$GIT" status -sb
echo "--- token in config count"
grep -c "$TOKEN" .git/config || true
