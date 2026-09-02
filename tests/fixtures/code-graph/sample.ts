// TypeScript fixture for overload metadata and accessor parsing.
function overloaded(value: string): string;
function overloaded(value: number): number;
function overloaded(value: string | number): string | number {
	return value;
}

class Accessors {
	get value(): string {
		return "value";
	}
	set value(next: string) {
		void next;
	}
}
