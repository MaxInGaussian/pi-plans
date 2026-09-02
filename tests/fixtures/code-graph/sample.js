// JavaScript fixture used by the code-graph parser tests. Includes nested
// arrow functions, classes with methods, getters/setters, and anonymous
// expressions assigned to variables.

function alpha(a, b) {
	return a + b;
}

const beta = function (x) {
	return x * 2;
};

const gamma = (y) => y + 1;

class Container {
	delta() {
		return 4;
	}
	get foo() {
		return "getter";
	}
	set foo(value) {
		this._foo = value;
	}
}

function epsilon(value) {
	const inner = (v) => v;
	return inner(value);
}

const factory = {
	make() {
		return () => 1;
	},
};
