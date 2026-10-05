# ============================================================================
# Solace 打包脚本（Windows 上用）
# ----------------------------------------------------------------------------
# 作用：把项目打成一个「可以直接上传到服务器」的 zip，自动排除掉
#       node_modules、.next、日志，以及含密钥的运行期文件。
#
# 用法（任选一种）：
#   1) 在终端里执行（推荐，最不容易出问题）：
#      powershell -ExecutionPolicy Bypass -File "E:\ai web project\solace\scripts\package.ps1"
#   2) 资源管理器里右键本文件 →「使用 PowerShell 运行」
#      （如果弹出「禁止运行脚本」之类的提示，改用上面第 1 种）
#
# 说明：脚本执行完（或出错）都会停下来等你按回车，方便看清结果。
#       生成的 zip 放在**项目上一级目录**（和项目文件夹同级），
#       例如项目在 E:\ai web project\solace，zip 就是 E:\ai web project\solace-20250101-1530.zip
# ============================================================================

$ErrorActionPreference = "Stop"

function Wait-BeforeExit {
    Write-Host ""
    try { Read-Host "按回车键关闭窗口" | Out-Null } catch { }
}

try {
    # 项目根目录（脚本在 scripts\ 下，上一级就是根目录）
    $root = if ($PSScriptRoot) {
        Split-Path -Parent $PSScriptRoot
    } else {
        Split-Path -Parent $MyInvocation.MyCommand.Path
    }
    if (-not $root -or -not (Test-Path (Join-Path $root "package.json"))) {
        throw "找不到项目根目录（该目录应当包含 package.json）。请确认本脚本位于 项目\scripts\ 目录下。"
    }

    $parent = Split-Path -Parent $root
    $projectName = Split-Path -Leaf $root
    $stamp = Get-Date -Format "yyyyMMdd-HHmm"
    # 输出到「项目上一级目录」，也就是和项目文件夹同级
    $target = Join-Path $parent "$projectName-$stamp.zip"
    $temp = Join-Path $env:TEMP "$projectName-upload-$stamp"

    Write-Host "项目目录：$root"
    Write-Host "输出文件：$target"
    Write-Host ""

    if (Test-Path $temp) { Remove-Item $temp -Recurse -Force }
    New-Item -ItemType Directory -Path $temp | Out-Null

    # 排除目录：依赖、构建产物、日志、版本库
    $excludeDirs = @("node_modules", ".next", ".vercel", "logs", ".git")
    # 排除文件：密钥与运行期生成的（传到新服务器会泄密或造成误判）
    $excludeFiles = @(".env.local", ".env.production", "db.json", "installed.lock")

    $robocopyArgs = @($root, $temp, "/E", "/NFL", "/NDL", "/NJH", "/NJS", "/NP")
    # ⚠️ 排除**目录**必须写完整路径。
    #    裸目录名（`/XD logs`）会匹配**任意层级**的同名目录 —— 实测把项目的
    #    `app/api/admin/logs/`（后台日志接口）一起排掉了：包里少一个接口文件，
    #    部署过去那一页直接坏掉，而打包日志只会说"已复制 214 个文件"，完全看不出来。
    foreach ($dir in $excludeDirs) { $robocopyArgs += "/XD"; $robocopyArgs += (Join-Path $root $dir) }
    # 排除**文件**用裸文件名是故意的：要排的 db.json / installed.lock 在 config/ 下，
    # 但它们的真实位置变过（早期版本在项目根），按文件名排更稳。
    foreach ($file in $excludeFiles) { $robocopyArgs += "/XF"; $robocopyArgs += $file }

    Write-Host "正在复制文件..."
    robocopy @robocopyArgs | Out-Null

    # robocopy 退出码 0-7 都算成功，>=8 才是出错
    if ($LASTEXITCODE -ge 8) {
        throw "复制文件失败（robocopy 退出码 $LASTEXITCODE），可能有文件被占用，请关掉编辑器后重试。"
    }

    $count = (Get-ChildItem $temp -Recurse -File).Count
    Write-Host "已复制 $count 个文件，正在压缩..."

    # 自检①：**换一条独立规则**重算"应当有多少文件"，专门抓"排除规则误伤业务目录"。
    #   上面那个 `/XD logs` 就是这么漏掉 `app/api/admin/logs/route.js` 的 ——
    #   这种缺失既不报错、也不影响构建，只让部署后某个接口坏掉，最难查。
    #   这里只按「**顶层**目录」排除，与上面改好后的全路径 /XD 等价。
    $expected = @(Get-ChildItem -LiteralPath $root -Recurse -File -Force | Where-Object {
            $rel = $_.FullName.Substring($root.Length + 1)
            -not ($excludeDirs | Where-Object { $rel.StartsWith($_ + "\") }) -and
            $excludeFiles -notcontains $_.Name
        }).Count
    if ($count -lt $expected) {
        throw "打包缺文件：临时目录 $count 个，按顶层排除规则应有 $expected 个。多半是排除项写成了裸目录名，误伤了同名的业务目录（历史上 app/api/admin/logs 就是这样被丢掉的）。"
    }
    if ($count -gt $expected) {
        Write-Host "提示：比预期多 $($count - $expected) 个文件（一般是新增文件，无害）。" -ForegroundColor Yellow
    }
    Write-Host "完整性自查：$count 个文件，无缺失 ✓（预期 $expected）"

    if (Test-Path $target) { Remove-Item $target -Force }

    # ⚠️ 这里必须**逐个文件**写入、并把路径分隔符强制换成正斜杠 `/`。
    #
    #    不要换回 `[System.IO.Compression.ZipFile]::CreateFromDirectory()`：
    #    它在 Windows 上会把路径写成**反斜杠**（`lib\tts-tags.js`），
    #    而 ZIP 规范（APPNOTE：所有斜杠必须是 `/`）与 Linux 的 `unzip` 只认正斜杠。
    #    后果很隐蔽：解包出的是 215 个名字里带 `\` 的**垃圾文件**，
    #    `\cp -rf /tmp/sp/. /www/wwwroot/solace/` 覆盖的全是这些假文件名 ——
    #    部署步骤全都"成功"了，代码却根本没更新。
    #    （实测：CreateFromDirectory 打出来的包里 197/215 个条目含反斜杠。）
    #
    #    为什么不用 Compress-Archive：它可能漏掉以点开头的隐藏文件（.env.example 这类）。
    Add-Type -AssemblyName System.IO.Compression
    $basePath = (Resolve-Path -LiteralPath $temp).Path
    $zipStream = [System.IO.File]::Open($target, [System.IO.FileMode]::Create)
    try {
        $archive = [System.IO.Compression.ZipArchive]::new($zipStream, [System.IO.Compression.ZipArchiveMode]::Create)
        try {
            foreach ($file in Get-ChildItem -LiteralPath $temp -Recurse -File -Force) {
                # 相对路径 + 反斜杠 → 正斜杠（这一行就是整个修复的关键）
                $entryName = $file.FullName.Substring($basePath.Length + 1).Replace('\', '/')
                $entry = $archive.CreateEntry($entryName, [System.IO.Compression.CompressionLevel]::Optimal)
                $entryStream = $entry.Open()
                try {
                    $sourceStream = [System.IO.File]::OpenRead($file.FullName)
                    try { $sourceStream.CopyTo($entryStream) } finally { $sourceStream.Dispose() }
                } finally { $entryStream.Dispose() }
            }
        } finally { $archive.Dispose() }
    } finally { $zipStream.Dispose() }
    Remove-Item $temp -Recurse -Force

    # 打完自查：含反斜杠的条目必须是 0（错了就直接报错，别把废包传上服务器）
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    $check = [System.IO.Compression.ZipFile]::OpenRead($target)
    try {
        $badNames = @($check.Entries | ForEach-Object { $_.FullName } | Where-Object { $_.Contains('\') })
        $totalEntries = $check.Entries.Count
    } finally { $check.Dispose() }
    if ($badNames.Count -gt 0) {
        throw "打包结果里有 $($badNames.Count) 个条目用了反斜杠路径（第一个：$($badNames[0])），这种包在 Linux 上解出来是错的，请检查上面的打包代码。"
    }
    Write-Host "路径分隔符自查：$totalEntries 个条目，0 个反斜杠 ✓"

    $sizeMb = [math]::Round((Get-Item $target).Length / 1MB, 2)

    Write-Host ""
    Write-Host "打包完成：$target" -ForegroundColor Green
    Write-Host "（$sizeMb MB，共 $count 个文件；已排除 node_modules / .next / .env.local / config 下的运行期文件）"
    Write-Host ""
    Write-Host "下一步：" -ForegroundColor Cyan
    Write-Host "  1. 宝塔 -> 文件 -> /www/wwwroot/ -> 上传这个 zip -> 右键解压"
    Write-Host "  2. 确认 /www/wwwroot/solace/package.json 直接在这个位置"
    Write-Host "  3. 在服务器上创建 .env.local（复制 .env.example 改名），填数据库与密钥"
    Write-Host "  4. 宝塔终端：npm install 与 npm run build，然后 pm2 start ecosystem.config.js"

    Wait-BeforeExit
}
catch {
    Write-Host ""
    Write-Host "打包失败：$($_.Exception.Message)" -ForegroundColor Red
    Write-Host ""
    Write-Host "如果上面提示「禁止运行脚本」，是本机 PowerShell 执行策略拦住了，用这条命令运行同样可以：" -ForegroundColor Yellow
    Write-Host '  powershell -ExecutionPolicy Bypass -File "<本脚本的完整路径>"'
    Wait-BeforeExit
    exit 1
}
