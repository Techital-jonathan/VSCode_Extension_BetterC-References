namespace Sample;

// Positional record: InStock is both the constructor parameter and the property.
public record PartDto(bool InStock, bool Reserved, string Label = "") // InStock: D
{
    public PartDto(bool reserved) : this(InStock: false, reserved) // InStock: W
    {
    }
}

public sealed class Part
{
    public bool Available { get; set; }
    public bool Reserved { get; set; }
}

[AttributeUsage(AttributeTargets.Method)]
public sealed class CacheAttribute : Attribute
{
    public bool Enabled { get; set; } // Enabled: D
}

public static class Mapping
{
    [Cache(Enabled = true)] // Enabled: W
    public static PartDto Map(Part part) => new PartDto(
        Label: $"odd ) text {part.Reserved} // not a comment, \"quoted (\"",
        Reserved: part.Reserved,
        // A comment between the arguments (with parentheses), ending with a period.
        /* A block comment; with a semicolon. */
        InStock: part.Available && (part.Available || part.Reserved)); // InStock: W

    public static PartDto MapFirst(Part part) => new PartDto(
        InStock: part.Available, // InStock: W
        Reserved: part.Reserved);

    public static PartDto Copy(PartDto dto) => new(InStock: dto.InStock, Reserved: false); // InStock: W R

    public static PartDto Restock(PartDto dto) => dto with { InStock = true }; // InStock: W

    public static bool IsInStock(PartDto dto) => dto is { Reserved: false, InStock: true }; // InStock: R

    public static bool Either(PartDto dto, bool flag) => Check(flag ? dto.InStock : false); // InStock: R

    public static bool Switch(PartDto dto) => dto switch { { InStock: true } => true, _ => false }; // InStock: R

    public static string Name() => nameof(PartDto.InStock); // InStock: R

    public static object Projection(PartDto dto) => new { dto.InStock, Other = dto.InStock }; // InStock: R R

    public static (bool InStock, int Count) Tuple(PartDto dto) => (InStock: dto.InStock, Count: 1); // InStock: - - R

    public static bool Deconstructed(PartDto dto)
    {
        var (inStock, _, _) = dto;
        return inStock;
    }

    private static bool Check(bool value) => value;
}
