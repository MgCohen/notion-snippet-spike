using System;
using System.Collections.Generic;
using System.Linq;

namespace SnippetSpike;

public record OrderLine(string Sku, int Quantity, decimal UnitPrice);

public record Order(Guid Id, string Customer, IReadOnlyList<OrderLine> Lines);

public class OrderService
{
    private readonly Dictionary<Guid, Order> _orders = new();

    // @snippet: create-order
    public Order Create(string customer, IEnumerable<OrderLine> lines)
    {
        var list = lines.ToList();
        if (list.Count == 0)
            throw new ArgumentException("An order needs at least one line.");
        if (list.Any(l => l.Quantity <= 0))
            throw new ArgumentException("Each line needs a positive quantity.");

        var order = new Order(Guid.NewGuid(), customer, list);
        _orders[order.Id] = order;
        return order;
    }
    // @end-snippet

    // @snippet: order-total
    public decimal Total(Order order)
    {
        var subtotal = order.Lines.Sum(l => l.Quantity * l.UnitPrice);
        return Math.Round(subtotal, 2, MidpointRounding.AwayFromZero);
    }
    // @end-snippet

    // @snippet: find-order
    public Order? Find(Guid id) =>
        _orders.TryGetValue(id, out var order) ? order : null;
    // @end-snippet
}
