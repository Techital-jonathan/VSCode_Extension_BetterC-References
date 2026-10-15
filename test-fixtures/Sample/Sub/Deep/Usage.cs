namespace Sample.Sub.Deep;

public static class Usage
{
    public static int Run(Counter counter)
    {
        counter.Total -= 1; // Total: W
        return counter.Total * 2; // Total: R
    }
}
