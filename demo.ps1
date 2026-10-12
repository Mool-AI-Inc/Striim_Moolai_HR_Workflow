# Run the whole migration demo from the terminal.
#
#   .\demo.ps1 reset     put everything back to the start
#   .\demo.ps1 arc       drive one onboarding arc (creates the ledger row)
#   .\demo.ps1 cdc       start change capture
#   .\demo.ps1 load      bulk copy, then wait until both sides match
#   .\demo.ps1 cutover   the five-step cutover
#   .\demo.ps1 proof     the idempotency proof
#   .\demo.ps1 status    where things stand
#   .\demo.ps1 all       everything, in order, with pauses
#
# Needs only the API on :8090. The UI is optional.

param([string]$step = "status")

$API = "http://127.0.0.1:8090"

function Post($path, $body = "{}") {
  Invoke-RestMethod -Method Post -Uri "$API/$path" -ContentType "application/json" -Body $body -TimeoutSec 240
}
function Get-Status { Invoke-RestMethod -Uri "$API/migration/status" -TimeoutSec 60 }

function Show-Tables {
  $s = Get-Status
  "  app is writing to : $($s.writingTo)"
  "  CDC               : $($s.cdcState)"
  "  replication slot  : $(if ($s.slot.exists) { "$($s.slot.name) ($($s.slot.plugin))" } else { 'not created' })"
  foreach ($t in $s.tables) {
    "    {0,-18} {1,5} -> {2,-5} {3}" -f $t.table, $t.source.rows, $t.target.rows, $(if ($t.match) { "match" } else { "DIFFERS" })
  }
}

function Wait-Match($label, $tries = 18) {
  for ($i = 1; $i -le $tries; $i++) {
    Start-Sleep -Seconds 10
    $s = Get-Status
    $line = ($s.tables | ForEach-Object { "$($_.table.Substring(0,[Math]::Min(10,$_.table.Length)))=$($_.source.rows)/$($_.target.rows)" }) -join "  "
    "  t+$($i*10)s  $line"
    if (($s.tables | Where-Object { -not $_.match }).Count -eq 0) { "  >>> both sides match (rows AND checksums)"; return $true }
  }
  "  !!! did not converge - check the Striim console"; return $false
}

switch ($step) {

  "status" { Show-Tables }

  "reset" {
    "Resetting..."
    Post "migration/reset" | Out-Null
    Show-Tables
    "`nReady. Next:  .\demo.ps1 arc"
  }

  "arc" {
    $emp = (Invoke-RestMethod -Uri "$API/employees" -TimeoutSec 60)[0].id
    "Running the onboarding arc for $emp ..."
    $j = Post "run" "{`"employeeId`":`"$emp`"}"
    foreach ($s in $j.steps) { "    {0,-28} {1}" -f $s.label, $s.status }
    "`nThe source database now holds a real ledger row and a real approval."
    Show-Tables
    "`nNext:  .\demo.ps1 cdc"
  }

  "cdc" {
    "Starting change capture (this also creates the replication slot) ..."
    $r = Post "migration/cdc/start"
    "  slot: $($r.slot.name)  plugin: $($r.slot.plugin)"
    "`nNext:  .\demo.ps1 load"
    "(If it refuses, that is the slot-not-held gate doing its job - wait and retry.)"
  }

  "load" {
    "Starting the bulk load ..."
    $r = Post "migration/initial-load"
    if (-not $r.ok) { "  REFUSED: $($r.reason)"; break }
    Wait-Match "load" | Out-Null
    "`nNext:  .\demo.ps1 cutover"
  }

  "cutover" {
    "Cutting over ..."
    $r = Post "migration/cutover"
    if ($r.ok) {
      foreach ($s in $r.steps) { "    {0,-20} {1}" -f $s.name, $s.detail }
      "`nThe application is now writing to the target. Nothing restarted."
    } else {
      "  REFUSED at $($r.refusedAt): $($r.reason)"
    }
    "`nNext:  .\demo.ps1 proof"
  }

  "proof" {
    $r = Post "migration/proof"
    ""
    "  reading database : $($r.readingDatabase)"
    "  idempotency key  : $($r.idempotencyKey)"
    "  skipped the send : $($r.skipped)"
    "  ledger rows      : $($r.ledgerRowsBefore) -> $($r.ledgerRowsAfter)  (unchanged)"
    ""
    "  The gate read the NEW database, found the key the OLD one wrote, and declined"
    "  to send. Nobody gets a second welcome email."
  }

  "all" {
    foreach ($s in @("reset", "arc", "cdc", "load", "cutover", "proof")) {
      "`n=============== $($s.ToUpper()) ==============="
      & $PSCommandPath $s
      if ($s -eq "cdc") { Start-Sleep -Seconds 20 }
    }
  }

  default { "unknown step '$step' - try: reset | arc | cdc | load | cutover | proof | status | all" }
}
