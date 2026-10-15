using Sample;
using Sample.Sub.Deep;

var counter = new Counter();
counter.Increment();
counter.Total = 3; // Total: W
Console.WriteLine(counter.Total + Usage.Run(counter)); // Total: R
