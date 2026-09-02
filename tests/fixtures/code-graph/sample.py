"""Fixture for Python code graph tests."""

def alpha(a, b):
    return a + b


async def beta(x):
    return x * 2


class Container:
    def delta(self):
        return 4

    @staticmethod
    def helper(value):
        return value


gamma = lambda y: y + 1
