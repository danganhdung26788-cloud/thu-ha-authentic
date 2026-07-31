[CmdletBinding(SupportsShouldProcess, ConfirmImpact = 'High')]
param(
  [Parameter(Mandatory = $true)]
  [switch]$ApproveFirewallChange
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if (-not $ApproveFirewallChange) { throw 'Firewall modification requires -ApproveFirewallChange.' }

$rules = @(
  @{ Name = 'Workflow-AI-V2-Hermes'; Port = 3201 },
  @{ Name = 'Workflow-AI-V2-Codex'; Port = 3202 }
)
foreach ($rule in $rules) {
  if ($PSCmdlet.ShouldProcess($rule.Name, "Allow TCP $($rule.Port) from LocalSubnet on Domain/Private profiles")) {
    Get-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue | Remove-NetFirewallRule
    New-NetFirewallRule `
      -DisplayName $rule.Name `
      -Direction Inbound `
      -Action Allow `
      -Protocol TCP `
      -LocalPort $rule.Port `
      -RemoteAddress LocalSubnet `
      -Profile Domain,Private | Out-Null
  }
}
Write-Host 'Workflow AI V2 firewall rules registered for LocalSubnet only.'
