# 无 Gradle 的 APK 构建脚本（aapt2 + javac + d8 + zipalign + apksigner）
#
# 位置：D:\dsh-assistant\android\build.ps1（本目录就是整个 Android 工程的根）
# 用法：
#   powershell -ExecutionPolicy Bypass -File D:\dsh-assistant\android\build.ps1 -Flavor generic -VersionName 1.1.0 -VersionCode 5
#   powershell -ExecutionPolicy Bypass -File ... -Sdk D:\android-sdk -Jdk "C:\Program Files\Eclipse Adoptium\jdk-17.0.17.10-hotspot"
#
# 路径全部由 $PSScriptRoot 推导，不写死任何绝对目录；SDK/JDK 找不到时报中文错误并提示用 -Sdk/-Jdk 覆盖。
param(
    [ValidateSet('personal', 'generic')][string]$Flavor = 'generic',
    [string]$VersionName = '1.1.0',
    [int]$VersionCode = 5,
    [string]$Sdk = '',
    [string]$Jdk = ''
)

$ErrorActionPreference = 'Stop'

# 两个变体：本机版预置入口、打开即用；通用版入口留空、首次打开进设置页（之后可随时长按返回键再改）。
$FLAVORS = @{
    personal = @{
        AppId           = 'com.chenpan.assistant'
        Label           = '个人助手'
        DefaultUrl      = 'http://***REMOVED***'
        Out             = '个人助手'
    }
    generic  = @{
        AppId           = 'com.chenpan.assistant.generic'
        Label           = '个人助手'
        DefaultUrl      = ''
        Out             = '个人助手-通用版'
    }
}
$V = $FLAVORS[$Flavor]

$ROOT      = $PSScriptRoot
$SRC       = Join-Path $ROOT 'app\src\main'
$OUT       = Join-Path $ROOT 'out'
$STAGE     = Join-Path $OUT "stage-$Flavor"
$GEN       = Join-Path $OUT "gen-$Flavor"
$CLS       = Join-Path $OUT "classes-$Flavor"
$DEX       = Join-Path $OUT "dex-$Flavor"
$DIST      = Join-Path $ROOT 'dist'
$KS        = Join-Path $ROOT 'assistant.keystore'
$KS_PASS   = '***REMOVED***'
$MIN_SDK   = 24
$TARGET    = 34

if (-not (Test-Path $SRC)) { throw "找不到源码目录：$SRC（build.ps1 必须放在 android\ 根目录里）" }
New-Item -ItemType Directory -Force -Path $OUT, $DIST | Out-Null

# ---- Android SDK ----
$SDK = if ($Sdk) { $Sdk } else { 'D:\android-sdk' }
$BT  = Join-Path $SDK 'build-tools\34.0.0'
$JAR = Join-Path $SDK 'platforms\android-34\android.jar'
if (-not (Test-Path $JAR) -or -not (Test-Path (Join-Path $BT 'aapt2.exe'))) {
    throw ("找不到 Android SDK（需要 platforms\android-34\android.jar 与 build-tools\34.0.0\）。
  现在找的是：$SDK
  请装好 SDK，或用参数指定：-Sdk ""D:\android-sdk""")
}

# ---- JDK 17 ----
$JAVA_HOME = if ($Jdk) { $Jdk } else { 'C:\Program Files\Eclipse Adoptium\jdk-17.0.17.10-hotspot' }
if (-not (Test-Path (Join-Path $JAVA_HOME 'bin\javac.exe'))) {
    throw ("找不到 JDK（需要 bin\javac.exe 与 bin\keytool.exe）。
  现在找的是：$JAVA_HOME
  请装好 JDK 17，或用参数指定：-Jdk ""C:\Program Files\Eclipse Adoptium\jdk-17.0.17.10-hotspot""")
}
# 设备线（鹈鹕）已整体移除：唤醒模型（TFLite/Porcupine AAR 与 .so）不再进 APK
$ASSETS = Join-Path $ROOT 'app\src\main\assets'
$ASSETARG = @()
if (Test-Path $ASSETS) { $ASSETARG = @('-A', $ASSETS) }
$env:JAVA_HOME = $JAVA_HOME
$env:PATH = "$JAVA_HOME\bin;$env:PATH"

Write-Host "== 1/9 清理（$Flavor）==" -ForegroundColor Cyan
foreach ($d in @($STAGE, $GEN, $CLS, $DEX)) {
    if (Test-Path $d) { Remove-Item $d -Recurse -Force }
    New-Item -ItemType Directory -Force -Path $d | Out-Null
}
$resZip   = Join-Path $OUT "res-$Flavor.zip"
$unsigned = Join-Path $OUT "$Flavor-unsigned.apk"
$aligned  = Join-Path $OUT "$Flavor-aligned.apk"
$final    = Join-Path $OUT "$($V.Out)-$VersionName.apk"
foreach ($tmpFile in @($resZip, $unsigned, $aligned, $final)) { if (Test-Path $tmpFile) { Remove-Item $tmpFile -Force } }

Write-Host '== 2/9 生成变体源码（包名 / 应用名 / 默认地址）==' -ForegroundColor Cyan
$basePkgPath = Join-Path $SRC 'java\com\chenpan\assistant'
$pkgPath = Join-Path $STAGE ("java\" + ($V.AppId -replace '\.', '\'))
New-Item -ItemType Directory -Force -Path $pkgPath | Out-Null
Copy-Item (Join-Path $SRC 'res') (Join-Path $STAGE 'res') -Recurse

# 同一个包里的所有 .java 都进变体（MainActivity + 悬浮球规则等纯逻辑类）
Get-ChildItem -Filter *.java $basePkgPath | ForEach-Object {
    $javaText = [System.IO.File]::ReadAllText($_.FullName, [System.Text.Encoding]::UTF8)
    $javaText = $javaText -replace '(?m)^package com\.chenpan\.assistant;', "package $($V.AppId);"
    $javaText = $javaText -replace '(?m)^(\s*private static final String DEFAULT_URL = ).*$', ('$1"' + $V.DefaultUrl + '";')
    [System.IO.File]::WriteAllText((Join-Path $pkgPath $_.Name), $javaText, (New-Object System.Text.UTF8Encoding($false)))
}

$manifest = [System.IO.File]::ReadAllText((Join-Path $SRC 'AndroidManifest.xml'), [System.Text.Encoding]::UTF8)
if ($V.AppId -ne 'com.chenpan.assistant') {
    $manifest = $manifest -replace 'package="com\.chenpan\.assistant"', ('package="' + $V.AppId + '"')
    $manifest = $manifest -replace 'android:name="\.MainActivity"', ('android:name="' + $V.AppId + '.MainActivity"')
}
[System.IO.File]::WriteAllText((Join-Path $STAGE 'AndroidManifest.xml'), $manifest, (New-Object System.Text.UTF8Encoding($false)))

$stringsPath = Join-Path $STAGE 'res\values\strings.xml'
$strings = [System.IO.File]::ReadAllText($stringsPath, [System.Text.Encoding]::UTF8)
$strings = $strings -replace '<string name="app_name">.*?</string>', ('<string name="app_name">' + $V.Label + '</string>')
[System.IO.File]::WriteAllText($stringsPath, $strings, (New-Object System.Text.UTF8Encoding($false)))

# 桌面快捷方式（长按图标 → 设置地址）里的 targetPackage / targetClass 也要跟着变
$shortcutPath = Join-Path $STAGE 'res\xml\shortcuts.xml'
if (Test-Path $shortcutPath) {
    $sc = [System.IO.File]::ReadAllText($shortcutPath, [System.Text.Encoding]::UTF8)
    $sc = $sc -replace 'com\.chenpan\.assistant', $V.AppId
    [System.IO.File]::WriteAllText($shortcutPath, $sc, (New-Object System.Text.UTF8Encoding($false)))
}
$shownUrl = if ($V.DefaultUrl) { $V.DefaultUrl } else { '(空，首次打开填)' }
Write-Host ("   包名 {0} / 名称 {1} / 助手默认 {2}" -f $V.AppId, $V.Label, $shownUrl) -ForegroundColor DarkGray
Write-Host ("   根目录 {0}" -f $ROOT) -ForegroundColor DarkGray

Write-Host '== 3/9 aapt2 compile 资源 ==' -ForegroundColor Cyan
& "$BT\aapt2.exe" compile --dir (Join-Path $STAGE 'res') -o $resZip
if ($LASTEXITCODE -ne 0) { throw 'aapt2 compile 失败' }

Write-Host '== 4/9 aapt2 link（生成 R.java + 资源 APK）==' -ForegroundColor Cyan
& "$BT\aapt2.exe" link `
    -o $unsigned `
    -I $JAR `
    --manifest (Join-Path $STAGE 'AndroidManifest.xml') `
    --java $GEN `
    --min-sdk-version $MIN_SDK `
    --target-sdk-version $TARGET `
    --version-code $VersionCode `
    --version-name $VersionName `
    $ASSETARG `
    $resZip
if ($LASTEXITCODE -ne 0) { throw 'aapt2 link 失败' }

Write-Host '== 5/9 javac 编译 Java ==' -ForegroundColor Cyan
$srcs = @()
$srcs += (Get-ChildItem -Recurse -Filter *.java (Join-Path $STAGE 'java') | ForEach-Object { $_.FullName })
$srcs += (Get-ChildItem -Recurse -Filter *.java $GEN | ForEach-Object { $_.FullName })
$argFile = Join-Path $OUT "sources-$Flavor.txt"
$srcs | ForEach-Object { '"' + ($_ -replace '\\', '\\') + '"' } | Set-Content -Path $argFile -Encoding ascii
& "$JAVA_HOME\bin\javac.exe" -nowarn -encoding UTF-8 -source 1.8 -target 1.8 `
    -bootclasspath $JAR -d $CLS "@$argFile"
if ($LASTEXITCODE -ne 0) { throw 'javac 失败' }

Write-Host '== 6/9 d8 转 dex ==' -ForegroundColor Cyan
# 1.3.8：类文件已经多到 80 个，d8.bat 走 cmd.exe，命令行上限 8191 字符会被撑爆
# （"The command line is too long."）。先把 classes 打成一个 jar 再交给 d8，
# 参数只剩一个路径，和类数量无关。
$classesJar = Join-Path $OUT "classes-$Flavor.jar"
if (Test-Path $classesJar) { Remove-Item $classesJar -Force }
Push-Location $CLS
try {
    & "$JAVA_HOME\bin\jar.exe" cf $classesJar .
    if ($LASTEXITCODE -ne 0) { throw 'jar 打包 class 失败' }
} finally { Pop-Location }
& "$BT\d8.bat" --lib $JAR --min-api $MIN_SDK --output $DEX $classesJar
if ($LASTEXITCODE -ne 0) { throw 'd8 失败' }

Write-Host '== 7/9 装 dex 进 APK ==' -ForegroundColor Cyan
Push-Location $DEX
try {
    & "$JAVA_HOME\bin\jar.exe" uf $unsigned 'classes.dex'
    if ($LASTEXITCODE -ne 0) { throw 'jar uf 失败' }
} finally { Pop-Location }

# 唤醒模型的原生库（Porcupine / TensorFlow Lite .so）不再打包：设备线已移除

Write-Host '== 8/9 zipalign 对齐 ==' -ForegroundColor Cyan
& "$BT\zipalign.exe" -p -f 4 $unsigned $aligned
if ($LASTEXITCODE -ne 0) { throw 'zipalign 失败' }

Write-Host '== 9/9 签名 ==' -ForegroundColor Cyan
if (-not (Test-Path $KS)) {
    Write-Host '   首次构建：生成签名密钥' -ForegroundColor Yellow
    & "$JAVA_HOME\bin\keytool.exe" -genkeypair -keystore $KS -alias assistant `
        -keyalg RSA -keysize 2048 -validity 10950 -storetype PKCS12 `
        -storepass $KS_PASS -keypass $KS_PASS `
        -dname 'CN=ChenPan, OU=Personal, O=dsh-assistant, L=Xiaogan, ST=Hubei, C=CN'
    if ($LASTEXITCODE -ne 0) { throw 'keytool 失败' }
}
& "$BT\apksigner.bat" sign `
    --ks $KS --ks-key-alias assistant `
    --ks-pass "pass:$KS_PASS" --key-pass "pass:$KS_PASS" `
    --min-sdk-version $MIN_SDK `
    --v1-signing-enabled true --v2-signing-enabled true --v3-signing-enabled true `
    --out $final $aligned
if ($LASTEXITCODE -ne 0) { throw 'apksigner 失败' }

& "$BT\apksigner.bat" verify $final
$distApk = Join-Path $DIST (Split-Path $final -Leaf)
Copy-Item $final $distApk -Force
Write-Host ''
Write-Host "== 完成：$final" -ForegroundColor Green
Write-Host ("   同时复制到：{0}" -f $distApk) -ForegroundColor Green
Write-Host ("   大小 {0} KB" -f [math]::Round((Get-Item $final).Length / 1KB, 1))
