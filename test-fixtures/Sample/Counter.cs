namespace Sample;

// Trailing comments are the expected access per occurrence, left to right:
// D = definition, W = write, R = read, - = same name but another symbol. The integration test checks them.
public class Counter
{
    private int _count; // _count: D

    public int Total { get; set; } // Total: D

    private string? _name; // _name: D

    public string Name => _name ??= "counter"; // _name: W

    public string Describe() => $"{nameof(_name)}={_name}"; // _name: R R

    public void Refs()
    {
        ref int alias = ref _count; // _count: W
        ref readonly int view = ref _count; // _count: R
        Interlocked.Increment(ref _count); // _count: W
        Peek(in _count); // _count: R
        alias++;
        _ = view;
    }

    public void Increment()
    {
        _count++; // _count: W
        _count += 2; // _count: W
        _count = _count + 1; // _count: W R
        if (_count > 10) Reset(); // _count: R
        Bump(ref _count); // _count: W
        Read(_count); // _count: R
        var (a, b) = (1, 2);
        (_count, Total) = (a, b); // _count: W | Total: W
        Total = _count; // Total: W | _count: R
        Total++; // Total: W
        TryGet(out _count); // _count: W
    }

    private static void Bump(ref int x) => x++;

    private static void Read(int x) { }

    private static void Peek(in int x) { }

    private static bool TryGet(out int x) { x = 1; return true; }

    public void Reset() => _count = 0; // _count: W

    public int Current => _count; // _count: R

    public Counter Clone() => new Counter { Total = Total }; // Total: W R
}
