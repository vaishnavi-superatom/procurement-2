# semantic - Windows launcher for the agent tool; the logic is in tool.js beside it.
# UTF-8 both ways: Windows PowerShell 5.1 pipes ASCII to programs by default,
# which turns any non-English text in the SQL or a name into '?'.
$utf8 = New-Object System.Text.UTF8Encoding $false
$OutputEncoding = $utf8
try { [Console]::OutputEncoding = $utf8 } catch { }
$node = if ($env:SA_NODE) { $env:SA_NODE } else { 'node' }
$input | & $node "$PSScriptRoot\tool.js" semantic @args
exit $LASTEXITCODE
