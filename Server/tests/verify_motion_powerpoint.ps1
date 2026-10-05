# Native Office API acceptance. Operates only on generated test decks.
param([switch]$Play, [string]$Only, [switch]$Control)
$ErrorActionPreference = 'Stop'
$taskRoot = [System.IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../.runlogs/motion-acceptance'))
$app = New-Object -ComObject PowerPoint.Application
$app.Visible = $true
$app.WindowState = 2
$report = @()
try {
    if ($Control) {
        $controlDeck = $app.Presentations.Add($true)
        $controlSlide = $controlDeck.Slides.Add(1, 12)
        $controlShape = $controlSlide.Shapes.AddTextbox(1, 80, 100, 500, 100)
        $controlShape.TextFrame.TextRange.Text = 'Native PowerPoint control (no Gor XML)'
        $controlDeck.SlideShowSettings.ShowType = 2
        $controlShow = $controlDeck.SlideShowSettings.Run()
        Start-Sleep -Milliseconds 800
        Write-Output "Control playback page: $($controlShow.View.Slide.SlideIndex)"
        $controlShow.View.Exit()
        $controlDeck.Saved = $true
        $controlDeck.Close()
        return
    }
    foreach ($name in @('effects', 'launch', 'consulting', 'launch-click')) {
        if ($Only -and $name -ne $Only) { continue }
        $deckPath = Join-Path $taskRoot "$name.pptx"
        $deck = $app.Presentations.Open($deckPath, $true, $false, [bool]$Play)
        try {
            $slides = @()
            for ($index = 1; $index -le $deck.Slides.Count; $index++) {
                $slide = $deck.Slides.Item($index)
                $effects = @()
                for ($i = 1; $i -le $slide.TimeLine.MainSequence.Count; $i++) {
                    $effect = $slide.TimeLine.MainSequence.Item($i)
                    $effects += [PSCustomObject]@{
                        index = $i; effectType = [int]$effect.EffectType; shape = $effect.Shape.Name
                        trigger = [int]$effect.Timing.TriggerType
                        duration = [double]$effect.Timing.Duration
                        delay = [double]$effect.Timing.TriggerDelayTime
                        exit = [bool]$effect.Exit
                    }
                }
                $slide.Export((Join-Path $taskRoot "$name-$index.png"), 'PNG', 1280, 720)
                $slides += [PSCustomObject]@{page=$index; transition=[int]$slide.SlideShowTransition.EntryEffect; effects=$effects}
            }
            $entry = [PSCustomObject]@{deck=$name; pages=$deck.Slides.Count; opened=$true; runtimeSlides=@(); slides=$slides}
            $report += $entry
            $reportName = if ($Play) { 'powerpoint-playback.json' } else { 'powerpoint-report.json' }
            $report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $taskRoot $reportName) -Encoding utf8
            if (-not $Play) { continue }
            $deck.SlideShowSettings.ShowType = 2
            $deck.SlideShowSettings.ShowWithAnimation = $true
            $show = $deck.SlideShowSettings.Run()
            # Office rejects COM calls while its initial transition is busy.
            # Wait for the longest bounded entrance before navigating again.
            Start-Sleep -Milliseconds 3200
            $played = @()
            for ($index = 1; $index -le $deck.Slides.Count; $index++) {
                Write-Output "Playing ${name} page $index"
                $show.View.GotoSlide($index, $true)
                Start-Sleep -Milliseconds 3200
                $played += [int]$show.View.Slide.SlideIndex
                $entry.runtimeSlides = $played
                $report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $taskRoot $reportName) -Encoding utf8
                if ($name -eq 'launch-click') {
                    $show.View.Next()
                    Start-Sleep -Milliseconds 600
                }
            }
            $show.View.Exit()
            $entry.runtimeSlides = $played
        } finally { try { $deck.Close() } catch { Write-Warning $_.Exception.Message } }
    }
} finally { try { $app.Quit() } catch { Write-Warning $_.Exception.Message } }
$reportName = if ($Play) { 'powerpoint-playback.json' } else { 'powerpoint-report.json' }
$report | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath (Join-Path $taskRoot $reportName) -Encoding utf8
$report | ForEach-Object { [PSCustomObject]@{deck=$_.deck; pages=$_.pages; runtimePages=$_.runtimeSlides.Count; effects=($_.slides.effects | Measure-Object).Count} } | ConvertTo-Json
