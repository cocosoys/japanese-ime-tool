<# TEST_DEBUG_DISABLED
===== 测试/调试脚本 · 已整体注释禁用（如需恢复请删除首尾注释包裹）=====

# Win11 微软拼音自定义短语 — 诊断与重载测试
$ErrorActionPreference = "SilentlyContinue"

Write-Host "=== Win11 微软拼音自定义短语诊断 ===" -ForegroundColor Cyan

# ─── 0. 备份 ───
Write-Host "`n--- 0. 备份 ---"
$src = "$env:APPDATA\Microsoft\InputMethod\Chs\CustomPhrases\ChsUserPhrase.dat"
if (Test-Path $src) { Copy-Item $src "$src.testbak" -Force; Write-Host "已备份 ChsUserPhrase.dat" }
$udl = "$env:APPDATA\Microsoft\InputMethod\Chs\ChsPinyinUDL.dat"
if (Test-Path $udl) { Copy-Item $udl "$udl.testbak" -Force; Write-Host "已备份 ChsPinyinUDL.dat" }

# ─── 1. 注册表检查 ───
Write-Host "`n--- 1. 注册表: 自定义短语开关 ---" -ForegroundColor Yellow
$regPaths = @(
    "HKCU:\Software\Microsoft\InputMethod\Settings\CHS",
    "HKCU:\Software\Microsoft\InputMethod\CHS"
)
foreach ($p in $regPaths) {
    if (Test-Path $p) {
        Write-Host "[$p]"
        Get-ItemProperty $p | Format-List
    }
}

# 检查自定义短语启用状态
Write-Host "`n--- 自定义短语功能是否开启? ---" -ForegroundColor Yellow
try {
    $props = Get-ItemProperty "HKCU:\Software\Microsoft\InputMethod\Settings\CHS"
    Write-Host "所有属性:"
    $props.PSObject.Properties | ForEach-Object { Write-Host ("  {0,-30} = {1}" -f $_.Name, $_.Value) }
} catch {
    Write-Host "(无法读取)"
}

# ─── 2. 文件内容确认 ───
Write-Host "`n--- 2. 文件内容快照 ---" -ForegroundColor Yellow
Write-Host "ChsUserPhrase.dat 大小: $((Get-Item $src).Length) bytes"
Write-Host "ChsPinyinUDL.dat 大小: $((Get-Item $udl).Length) bytes"

# 用 .NET 读取 machxudp 看词条数
$buf = [System.IO.File]::ReadAllBytes($src)
$m = [System.Text.Encoding]::ASCII.GetString($buf, 0, 8)
Write-Host "machxudp magic: $m"
$count = [BitConverter]::ToInt32($buf, 28)
Write-Host "machxudp count (offset28): $count"

# ─── 3. IME 进程状态 ───
Write-Host "`n--- 3. 当前 IME 相关进程 ---" -ForegroundColor Yellow
Get-Process | Where-Object { $_.ProcessName -match 'ChsIME|TextInputHost|Microsoft\.IME|ctfmon' } |
    Select-Object ProcessName, Id, StartTime | Format-Table -AutoSize
if (-not $?) { Write-Host "(无 IME 进程)" }

# ─── 4. 尝试多种重载方式 ───
Write-Host "`n--- 4. IME 重载测试 ---" -ForegroundColor Yellow

Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public class ImeReloader {
    [DllImport("user32.dll", SetLastError=true)]
    public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);
    
    public static int SendSettingChange(string area) {
        try {
            UIntPtr r;
            IntPtr result = SendMessageTimeout((IntPtr)0xffff, 0x1a, UIntPtr.Zero, area, 2, 5000, out r);
            return result.ToInt32();
        } catch { return -1; }
    }
}
'@

Write-Host "4a. 发送 WM_SETTINGCHANGE('Environment')..."
[ImeReloader]::SendSettingChange("Environment")
Start-Sleep -Milliseconds 500

Write-Host "4b. 发送 WM_SETTINGChange('')..."
[ImeReloader]::SendSettingChange("")
Start-Sleep -Milliseconds 500

# 终止并重启 IME 进程
Write-Host "4c. 终止 IME 进程..."
$killList = @("ChsIME", "TextInputHost", "Microsoft.IME.OEM")
foreach ($k in $killList) {
    Get-Process -Name $k -ErrorAction SilentlyContinue | Stop-Process -Force
}
Write-Host "已终止，等待重启..."
Start-Sleep -Milliseconds 1200

Write-Host "4d. 再次发送 WM_SETTINGCHANGE..."
[ImeReloader]::SendSettingChange("Environment")

# ─── 5. 最终进程状态 ───
Write-Host "`n--- 5. 重载后 IME 进程 ---" -ForegroundColor Yellow
Get-Process | Where-Object { $_.ProcessName -match 'ChsIME|TextInputHost|Microsoft\.IME|ctfmon' } |
    Select-Object ProcessName, Id | Format-Table -AutoSize

Write-Host "`n=== 测试完成 ===" -ForegroundColor Green
Write-Host "请手动验证：在输入框输入 q + 空格，看是否有候选词出现" -ForegroundColor White


===== 测试/调试脚本结束 ===== #>
