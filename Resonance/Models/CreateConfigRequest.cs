namespace Resonance.Models;

/// <summary>
/// Request to create a Hume EVI configuration via the REST API.
/// </summary>
public sealed class CreateConfigRequest
{
    public required string ApiKey { get; set; }
}
