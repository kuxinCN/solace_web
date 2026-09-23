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
    foreach ($dir in $excludeDirs) { $robocopyArgs += "/XD"; $robocopyArgs += $dir }
    foreach ($file in $excludeFiles) { $robocopyArgs += "/XF"; $robocopyArgs += $file }

    Write-Host "正在复制文件..."
    robocopy @robocopyArgs | Out-Null

    # robocopy 退出码 0-7 都算成功，>=8 才是出错
    if ($LASTEXITCODE -ge 8) {
        throw "复制文件失败（robocopy 退出码 $LASTEXITCODE），可能有文件被占用，请关掉编辑器后重试。"
    }

    $count = (Get-ChildItem $temp -Recurse -File).Count
    Write-Host "已复制 $count 个文件，正在压缩..."

    if (Test-Path $target) { Remove-Item $target -Force }

    # 用 .NET 的 ZipFile：不会漏掉以点开头的文件（Compress-Archive 可能漏）
    Add-Type -AssemblyName System.IO.Compression.FileSystem
    [System.IO.Compression.ZipFile]::CreateFromDirectory($temp, $target)
    Remove-Item $temp -Recurse -Force

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
