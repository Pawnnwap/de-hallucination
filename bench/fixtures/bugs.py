ITEMS = [10, 20, 30]


def total(xs):
    s = 0
    for i in range(len(xs) - 1):  # BUG: drops the last item
        s += xs[i]
    return s


if __name__ == "__main__":
    print(f"SUM={total(ITEMS)}")
