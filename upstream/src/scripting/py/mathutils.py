"""Vector math for scripts (Vector, Matrix, Euler, Quaternion, Color).

An independent pure-Python implementation whose public names follow the documented
`mathutils` module so existing scripts keep working. Matrices are row-major and act on
column vectors (``M @ v``). Euler order 'XYZ' applies the X rotation first.
"""

import math

__all__ = ("Vector", "Matrix", "Euler", "Quaternion", "Color", "geometry", "noise")

_EPS = 1e-12


def _seq(v):
    if isinstance(v, (Vector, Euler, Quaternion, Color)):
        return [v[i] for i in range(len(v))]
    return [float(x) for x in v]


def _fmt(x):
    s = repr(round(float(x), 4))
    return s


class _Base:
    """Component storage shared by all vector-like types; subclasses may override the
    three storage hooks to read/write through to document data (bound vectors)."""

    __slots__ = ("_d",)

    def __init__(self, seq=(0.0, 0.0, 0.0)):
        object.__setattr__(self, "_d", [float(x) for x in _seq(seq)])

    # storage hooks
    def _len(self):
        return len(self._d)

    def _getc(self, i):
        return self._d[i]

    def _setc(self, i, v):
        self._d[i] = float(v)

    # sequence protocol
    def __len__(self):
        return self._len()

    def __getitem__(self, i):
        n = self._len()
        if isinstance(i, slice):
            return tuple(self._getc(k) for k in range(*i.indices(n)))
        if i < 0:
            i += n
        if not 0 <= i < n:
            raise IndexError("index out of range")
        return self._getc(i)

    def __setitem__(self, i, v):
        n = self._len()
        if isinstance(i, slice):
            idx = list(range(*i.indices(n)))
            vals = list(v)
            if len(vals) != len(idx):
                raise ValueError("slice assignment: size mismatch")
            for k, x in zip(idx, vals):
                self._setc(k, x)
            return
        if i < 0:
            i += n
        if not 0 <= i < n:
            raise IndexError("index out of range")
        self._setc(i, float(v))

    def __iter__(self):
        return iter([self._getc(i) for i in range(self._len())])

    def _list(self):
        return [self._getc(i) for i in range(self._len())]

    def _assign(self, seq):
        vals = _seq(seq)
        for i in range(self._len()):
            self._setc(i, vals[i] if i < len(vals) else 0.0)
        return self

    def to_tuple(self, precision=-1):
        if precision < 0:
            return tuple(self._list())
        return tuple(round(x, precision) for x in self._list())

    def to_list(self):
        return self._list()

    def copy(self):
        return type(self).__mro__[self._plain_index()](self._list())

    def _plain_index(self):
        # first non-bound class in the MRO (bound subclasses are named _Bound*)
        for k, c in enumerate(type(self).__mro__):
            if not c.__name__.startswith("_Bound"):
                return k
        return 0

    def __copy__(self):
        return self.copy()

    def __deepcopy__(self, memo):
        return self.copy()

    def freeze(self):
        return self

    @property
    def is_frozen(self):
        return False

    @property
    def is_wrapped(self):
        return False

    def __eq__(self, other):
        try:
            o = _seq(other)
        except TypeError:
            return NotImplemented
        return len(o) == self._len() and all(a == b for a, b in zip(self._list(), o))

    def __ne__(self, other):
        r = self.__eq__(other)
        return r if r is NotImplemented else not r

    __hash__ = None


def _swizzle(name):
    if 2 <= len(name) <= 4 and all(c in "xyzw" for c in name):
        return ["xyzw".index(c) for c in name]
    return None


class Vector(_Base):
    __slots__ = ()

    def __init__(self, seq=(0.0, 0.0, 0.0)):
        _Base.__init__(self, seq)

    # components
    @property
    def x(self):
        return self[0]

    @x.setter
    def x(self, v):
        self[0] = v

    @property
    def y(self):
        return self[1]

    @y.setter
    def y(self, v):
        self[1] = v

    @property
    def z(self):
        return self[2]

    @z.setter
    def z(self, v):
        self[2] = v

    @property
    def w(self):
        return self[3]

    @w.setter
    def w(self, v):
        self[3] = v

    def __getattr__(self, name):
        idx = _swizzle(name)
        if idx is None or max(idx) >= self._len():
            raise AttributeError("Vector has no attribute '%s'" % name)
        return Vector([self._getc(i) for i in idx])

    def __setattr__(self, name, value):
        idx = _swizzle(name)
        if idx is not None and len(name) > 1:
            vals = _seq(value)
            for i, v in zip(idx, vals):
                self[i] = v
            return
        object.__setattr__(self, name, value)

    # metrics
    @property
    def length(self):
        return math.sqrt(sum(x * x for x in self._list()))

    @length.setter
    def length(self, value):
        n = self.length
        if n > _EPS:
            self._assign([x * value / n for x in self._list()])

    @property
    def length_squared(self):
        return sum(x * x for x in self._list())

    @property
    def magnitude(self):
        return self.length

    def normalized(self):
        n = self.length
        if n < _EPS:
            return Vector([0.0] * self._len())
        return Vector([x / n for x in self._list()])

    def normalize(self):
        self._assign(self.normalized())
        return None

    def zero(self):
        self._assign([0.0] * self._len())

    def negate(self):
        self._assign([-x for x in self._list()])

    def dot(self, other):
        return sum(a * b for a, b in zip(self._list(), _seq(other)))

    def cross(self, other):
        a, b = self._list(), _seq(other)
        if len(a) == 2:
            return a[0] * b[1] - a[1] * b[0]
        return Vector((a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]))

    def angle(self, other, fallback=None):
        o = Vector(other)
        d = self.length * o.length
        if d < _EPS:
            if fallback is not None:
                return fallback
            raise ValueError("Vector.angle(other): zero length vectors have no valid angle")
        return math.acos(max(-1.0, min(1.0, self.dot(o) / d)))

    def angle_signed(self, other, fallback=None):
        a = self.angle(other, fallback)
        return a if self.cross(other) >= 0 else -a

    def lerp(self, other, factor):
        return Vector([a + (b - a) * factor for a, b in zip(self._list(), _seq(other))])

    def slerp(self, other, factor, fallback=None):
        a, b = self.normalized(), Vector(other).normalized()
        om = a.angle(b, fallback if fallback is not None else 0.0)
        if abs(om) < 1e-9:
            return self.lerp(other, factor)
        s = math.sin(om)
        la = self.length + (Vector(other).length - self.length) * factor
        r = a * (math.sin((1 - factor) * om) / s) + b * (math.sin(factor * om) / s)
        return r * la

    def project(self, other):
        o = Vector(other)
        d = o.length_squared
        return o * (self.dot(o) / d) if d > _EPS else o * 0.0

    def reflect(self, mirror):
        n = Vector(mirror).normalized()
        return self - n * (2.0 * self.dot(n))

    def rotate(self, other):
        if isinstance(other, (Euler, Quaternion)):
            m = other.to_matrix()
        else:
            m = other.to_3x3()
        self._assign(m @ self.to_3d())

    def rotation_difference(self, other):
        a, b = self.normalized(), Vector(other).normalized()
        axis = a.cross(b)
        d = max(-1.0, min(1.0, a.dot(b)))
        if axis.length < 1e-9:
            if d > 0:
                return Quaternion()
            perp = Vector((1, 0, 0)).cross(a)
            if perp.length < 1e-6:
                perp = Vector((0, 1, 0)).cross(a)
            return Quaternion(perp.normalized(), math.pi)
        return Quaternion(axis.normalized(), math.acos(d))

    def to_2d(self):
        return Vector(self._list()[:2])

    def to_3d(self):
        v = self._list() + [0.0, 0.0, 0.0]
        return Vector(v[:3])

    def to_4d(self):
        v = self._list()
        v = (v + [0.0, 0.0, 0.0])[:3] + [v[3] if len(v) > 3 else 1.0]
        return Vector(v)

    def resized(self, size):
        v = self._list() + [0.0] * size
        return Vector(v[:size])

    def resize_3d(self):
        raise TypeError("cannot resize a wrapped or fixed-size vector; use to_3d()")

    def to_track_quat(self, track="Y", up="Z"):
        axes = {"X": Vector((1, 0, 0)), "Y": Vector((0, 1, 0)), "Z": Vector((0, 0, 1)), "-X": Vector((-1, 0, 0)), "-Y": Vector((0, -1, 0)), "-Z": Vector((0, 0, -1))}
        return axes[track].rotation_difference(self)

    def orthogonal(self):
        x, y, z = self.to_3d()
        if abs(x) < abs(z):
            return Vector((0, -z, y)) if abs(x) < abs(y) else Vector((-z, 0, x))
        return Vector((-y, x, 0))

    # arithmetic
    def __add__(self, o):
        return Vector([a + b for a, b in zip(self._list(), _seq(o))])

    __radd__ = __add__

    def __sub__(self, o):
        return Vector([a - b for a, b in zip(self._list(), _seq(o))])

    def __rsub__(self, o):
        return Vector([b - a for a, b in zip(self._list(), _seq(o))])

    def __mul__(self, o):
        if isinstance(o, (int, float)):
            return Vector([a * o for a in self._list()])
        if isinstance(o, (Matrix, Quaternion)):
            return NotImplemented
        return Vector([a * b for a, b in zip(self._list(), _seq(o))])

    def __rmul__(self, o):
        return self.__mul__(o)

    def __truediv__(self, o):
        if o == 0:
            raise ZeroDivisionError("Vector division by zero")
        return Vector([a / o for a in self._list()])

    def __matmul__(self, o):
        if isinstance(o, Matrix):
            # row vector times matrix
            m = o.transposed()
            return m @ self
        return self.dot(o)

    def __neg__(self):
        return Vector([-a for a in self._list()])

    def __pos__(self):
        return Vector(self._list())

    def __abs__(self):
        return Vector([abs(a) for a in self._list()])

    def __iadd__(self, o):
        self._assign(self + o)
        return self

    def __isub__(self, o):
        self._assign(self - o)
        return self

    def __imul__(self, o):
        self._assign(self * o)
        return self

    def __itruediv__(self, o):
        self._assign(self / o)
        return self

    def __lt__(self, o):
        return self.length < Vector(o).length

    def __gt__(self, o):
        return self.length > Vector(o).length

    def __repr__(self):
        return "Vector((%s))" % ", ".join(_fmt(x) for x in self._list())

    def __str__(self):
        return "<Vector (%s)>" % ", ".join("%.4f" % x for x in self._list())

    @classmethod
    def Fill(cls, size, fill=0.0):
        return cls([fill] * size)

    @classmethod
    def Range(cls, start, stop=None, step=1):
        if stop is None:
            start, stop = 0, start
        return cls(list(range(start, stop, step)))

    @classmethod
    def Linspace(cls, start, stop, size):
        if size == 1:
            return cls([start])
        return cls([start + (stop - start) * i / (size - 1) for i in range(size)])


class Color(_Base):
    __slots__ = ()

    def __init__(self, rgb=(0.0, 0.0, 0.0)):
        _Base.__init__(self, rgb)

    r = property(lambda s: s[0], lambda s, v: s.__setitem__(0, v))
    g = property(lambda s: s[1], lambda s, v: s.__setitem__(1, v))
    b = property(lambda s: s[2], lambda s, v: s.__setitem__(2, v))

    @property
    def a(self):
        return self[3] if len(self) > 3 else 1.0

    @a.setter
    def a(self, v):
        if len(self) > 3:
            self[3] = v

    @property
    def h(self):
        return self._hsv()[0]

    @property
    def s(self):
        return self._hsv()[1]

    @property
    def v(self):
        return self._hsv()[2]

    @property
    def hsv(self):
        return self._hsv()

    @hsv.setter
    def hsv(self, hsv):
        h, s, v = hsv
        i = int(h * 6.0) % 6
        f = h * 6.0 - int(h * 6.0)
        p, q, t = v * (1 - s), v * (1 - s * f), v * (1 - s * (1 - f))
        rgb = [(v, t, p), (q, v, p), (p, v, t), (p, q, v), (t, p, v), (v, p, q)][i]
        for k in range(3):
            self[k] = rgb[k]

    def _hsv(self):
        r, g, b = self[0], self[1], self[2]
        mx, mn = max(r, g, b), min(r, g, b)
        d = mx - mn
        h = 0.0
        if d > 0:
            if mx == r:
                h = ((g - b) / d) % 6
            elif mx == g:
                h = (b - r) / d + 2
            else:
                h = (r - g) / d + 4
            h /= 6.0
        return (h, d / mx if mx > 0 else 0.0, mx)

    def __add__(self, o):
        return Color([a + b for a, b in zip(self._list(), _seq(o))])

    def __sub__(self, o):
        return Color([a - b for a, b in zip(self._list(), _seq(o))])

    def __mul__(self, f):
        return Color([a * f for a in self._list()])

    __rmul__ = __mul__

    def __repr__(self):
        return "Color((%s))" % ", ".join(_fmt(x) for x in self._list())

    def __str__(self):
        return "<Color (r=%.4f, g=%.4f, b=%.4f)>" % (self[0], self[1], self[2])


def _axis_matrix(axis, angle):
    c, s = math.cos(angle), math.sin(angle)
    if axis == "X":
        return [[1, 0, 0], [0, c, -s], [0, s, c]]
    if axis == "Y":
        return [[c, 0, s], [0, 1, 0], [-s, 0, c]]
    return [[c, -s, 0], [s, c, 0], [0, 0, 1]]


def _mul3(a, b):
    return [[sum(a[i][k] * b[k][j] for k in range(3)) for j in range(3)] for i in range(3)]


class Euler(_Base):
    __slots__ = ("_order",)

    def __init__(self, angles=(0.0, 0.0, 0.0), order="XYZ"):
        _Base.__init__(self, angles)
        if order not in ("XYZ", "XZY", "YXZ", "YZX", "ZXY", "ZYX"):
            raise ValueError("Euler(): invalid order '%s'" % order)
        object.__setattr__(self, "_order", order)

    @property
    def order(self):
        return self._order

    @order.setter
    def order(self, v):
        if v not in ("XYZ", "XZY", "YXZ", "YZX", "ZXY", "ZYX"):
            raise ValueError("Euler.order: invalid order")
        object.__setattr__(self, "_order", v)

    x = property(lambda s: s[0], lambda s, v: s.__setitem__(0, v))
    y = property(lambda s: s[1], lambda s, v: s.__setitem__(1, v))
    z = property(lambda s: s[2], lambda s, v: s.__setitem__(2, v))

    def copy(self):
        return Euler(self._list(), self.order)

    def to_matrix(self):
        m = [[1, 0, 0], [0, 1, 0], [0, 0, 1]]
        idx = {"X": 0, "Y": 1, "Z": 2}
        for ax in self.order:
            m = _mul3(_axis_matrix(ax, self[idx[ax]]), m)
        return Matrix(m)

    def to_quaternion(self):
        return self.to_matrix().to_quaternion()

    def zero(self):
        self._assign((0, 0, 0))

    def make_compatible(self, other):
        o = _seq(other)
        for i in range(3):
            v = self[i]
            while v - o[i] > math.pi:
                v -= 2 * math.pi
            while o[i] - v > math.pi:
                v += 2 * math.pi
            self[i] = v

    def rotate_axis(self, axis, angle):
        m = Matrix(_axis_matrix(axis, angle)) @ self.to_matrix()
        self._assign(m.to_euler(self.order))

    def rotate(self, other):
        m = (other.to_matrix() if isinstance(other, (Euler, Quaternion)) else other.to_3x3()) @ self.to_matrix()
        self._assign(m.to_euler(self.order, self))

    def __repr__(self):
        return "Euler((%s), '%s')" % (", ".join(_fmt(x) for x in self._list()), self.order)

    def __str__(self):
        return "<Euler (x=%.4f, y=%.4f, z=%.4f), order='%s'>" % (self[0], self[1], self[2], self.order)


class Quaternion(_Base):
    __slots__ = ()

    def __init__(self, seq=(1.0, 0.0, 0.0, 0.0), angle=None):
        if angle is not None:
            ax = Vector(seq).normalized()
            s = math.sin(angle / 2.0)
            _Base.__init__(self, (math.cos(angle / 2.0), ax[0] * s, ax[1] * s, ax[2] * s))
        else:
            _Base.__init__(self, seq)
            if len(self._d) != 4:
                raise ValueError("Quaternion(): expected 4 values (w, x, y, z)")

    w = property(lambda s: s[0], lambda s, v: s.__setitem__(0, v))
    x = property(lambda s: s[1], lambda s, v: s.__setitem__(1, v))
    y = property(lambda s: s[2], lambda s, v: s.__setitem__(2, v))
    z = property(lambda s: s[3], lambda s, v: s.__setitem__(3, v))

    @property
    def magnitude(self):
        return math.sqrt(sum(x * x for x in self._list()))

    @property
    def angle(self):
        w = self.normalized()[0]
        return 2.0 * math.acos(max(-1.0, min(1.0, w)))

    @property
    def axis(self):
        q = self.normalized()
        s = math.sqrt(max(0.0, 1.0 - q[0] * q[0]))
        if s < 1e-9:
            return Vector((1.0, 0.0, 0.0))
        return Vector((q[1] / s, q[2] / s, q[3] / s))

    def to_axis_angle(self):
        return (self.axis, self.angle)

    def normalized(self):
        n = self.magnitude
        if n < _EPS:
            return Quaternion()
        return Quaternion([x / n for x in self._list()])

    def normalize(self):
        self._assign(self.normalized())

    def conjugated(self):
        w, x, y, z = self._list()
        return Quaternion((w, -x, -y, -z))

    def conjugate(self):
        self._assign(self.conjugated())

    def inverted(self):
        n = sum(v * v for v in self._list())
        w, x, y, z = self._list()
        return Quaternion((w / n, -x / n, -y / n, -z / n))

    def invert(self):
        self._assign(self.inverted())

    def identity(self):
        self._assign((1, 0, 0, 0))

    def negate(self):
        self._assign([-v for v in self._list()])

    def dot(self, o):
        return sum(a * b for a, b in zip(self._list(), _seq(o)))

    def cross(self, o):
        return self @ o

    def to_matrix(self):
        w, x, y, z = self.normalized()._list()
        return Matrix((
            (1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)),
            (2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)),
            (2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)),
        ))

    def to_euler(self, order="XYZ", euler_compat=None):
        return self.to_matrix().to_euler(order, euler_compat)

    def to_exponential_map(self):
        return self.axis * self.angle

    def slerp(self, other, factor):
        a = self.normalized()._list()
        b = Quaternion(other).normalized()._list()
        d = sum(p * q for p, q in zip(a, b))
        if d < 0:
            b = [-v for v in b]
            d = -d
        if d > 0.9995:
            return Quaternion([p + (q - p) * factor for p, q in zip(a, b)]).normalized()
        th = math.acos(d)
        s = math.sin(th)
        wa, wb = math.sin((1 - factor) * th) / s, math.sin(factor * th) / s
        return Quaternion([p * wa + q * wb for p, q in zip(a, b)])

    def rotation_difference(self, other):
        return self.inverted() @ Quaternion(other)

    def rotate(self, other):
        q = other if isinstance(other, Quaternion) else other.to_quaternion()
        self._assign(q @ self)

    def make_compatible(self, other):
        if self.dot(other) < 0:
            self.negate()

    def __matmul__(self, o):
        if isinstance(o, Quaternion):
            aw, ax, ay, az = self._list()
            bw, bx, by, bz = o._list()
            return Quaternion((
                aw * bw - ax * bx - ay * by - az * bz,
                aw * bx + ax * bw + ay * bz - az * by,
                aw * by - ax * bz + ay * bw + az * bx,
                aw * bz + ax * by - ay * bx + az * bw,
            ))
        return self.to_matrix() @ Vector(o)

    def __mul__(self, o):
        if isinstance(o, (int, float)):
            return Quaternion([v * o for v in self._list()])
        return Quaternion([a * b for a, b in zip(self._list(), _seq(o))])

    __rmul__ = __mul__

    def __add__(self, o):
        return Quaternion([a + b for a, b in zip(self._list(), _seq(o))])

    def __sub__(self, o):
        return Quaternion([a - b for a, b in zip(self._list(), _seq(o))])

    def __neg__(self):
        return Quaternion([-v for v in self._list()])

    def __repr__(self):
        return "Quaternion((%s))" % ", ".join(_fmt(x) for x in self._list())

    def __str__(self):
        return "<Quaternion (w=%.4f, x=%.4f, y=%.4f, z=%.4f)>" % tuple(self._list())


class _MatrixRow:
    """A live row view so ``m[0][3] = 1`` writes into the matrix."""

    __slots__ = ("_m", "_r")

    def __init__(self, m, r):
        self._m, self._r = m, r

    def __len__(self):
        return len(self._m._rows[self._r])

    def __getitem__(self, j):
        return self._m._rows[self._r][j]

    def __setitem__(self, j, v):
        if isinstance(j, slice):
            idx = list(range(*j.indices(len(self))))
            for k, x in zip(idx, v):
                self._m._rows[self._r][k] = float(x)
            return
        self._m._rows[self._r][j] = float(v)

    def __iter__(self):
        return iter(list(self._m._rows[self._r]))

    def to_vector(self):
        return Vector(self._m._rows[self._r])

    def __getattr__(self, name):
        return getattr(Vector(self._m._rows[self._r]), name)

    def __add__(self, o):
        return Vector(self._m._rows[self._r]) + o

    def __sub__(self, o):
        return Vector(self._m._rows[self._r]) - o

    def __mul__(self, o):
        return Vector(self._m._rows[self._r]) * o

    def __eq__(self, o):
        return list(self) == list(o)

    def __repr__(self):
        return repr(Vector(self._m._rows[self._r]))


class Matrix:
    __slots__ = ("_rows",)

    def __init__(self, rows=None):
        if rows is None:
            rows = [[1.0 if i == j else 0.0 for j in range(4)] for i in range(4)]
        self._rows = [[float(x) for x in r] for r in rows]
        n = len(self._rows)
        if not (2 <= n <= 4) or any(len(r) != len(self._rows[0]) for r in self._rows):
            raise ValueError("Matrix(): expected 2x2 .. 4x4 rows of equal length")

    # constructors
    @classmethod
    def Identity(cls, size=4):
        return cls([[1.0 if i == j else 0.0 for j in range(size)] for i in range(size)])

    @classmethod
    def Translation(cls, v):
        v = _seq(v) + [0.0, 0.0, 0.0]
        m = cls.Identity(4)
        m._rows[0][3], m._rows[1][3], m._rows[2][3] = v[0], v[1], v[2]
        return m

    @classmethod
    def Rotation(cls, angle, size=4, axis="Z"):
        if size == 2:
            c, s = math.cos(angle), math.sin(angle)
            return cls(((c, -s), (s, c)))
        if isinstance(axis, str):
            r = _axis_matrix(axis, angle)
        else:
            r = Quaternion(axis, angle).to_matrix()._rows
        m = cls(r)
        return m.to_4x4() if size == 4 else m

    @classmethod
    def Scale(cls, factor, size=4, axis=None):
        m = cls.Identity(size)
        k = min(size, 3)
        if axis is None:
            for i in range(k):
                m._rows[i][i] = float(factor)
            return m
        n = Vector(axis).normalized()
        for i in range(k):
            for j in range(k):
                m._rows[i][j] += (factor - 1.0) * n[i] * n[j]
        return m

    @classmethod
    def Diagonal(cls, v):
        v = _seq(v)
        m = cls.Identity(len(v))
        for i, x in enumerate(v):
            m._rows[i][i] = x
        return m

    @classmethod
    def OrthoProjection(cls, axis, size=4):
        m = cls.Identity(size)
        i = {"X": 0, "Y": 1, "Z": 2, "XY": 2, "XZ": 1, "YZ": 0}[axis if isinstance(axis, str) else "Z"]
        m._rows[i][i] = 0.0
        return m

    @classmethod
    def LocRotScale(cls, location, rotation, scale):
        if rotation is None:
            r = Matrix.Identity(3)
        elif isinstance(rotation, (Euler, Quaternion)):
            r = rotation.to_matrix()
        else:
            r = rotation.to_3x3()
        s = _seq(scale) if scale is not None else [1.0, 1.0, 1.0]
        m = Matrix.Identity(4)
        for i in range(3):
            for j in range(3):
                m._rows[i][j] = r._rows[i][j] * s[j]
        loc = _seq(location) if location is not None else [0.0, 0.0, 0.0]
        for i in range(3):
            m._rows[i][3] = loc[i]
        return m

    # sequence protocol
    def __len__(self):
        return len(self._rows)

    def __getitem__(self, i):
        if isinstance(i, tuple):
            return self._rows[i[0]][i[1]]
        if i < 0:
            i += len(self._rows)
        return _MatrixRow(self, i)

    def __setitem__(self, i, row):
        if isinstance(i, tuple):
            self._rows[i[0]][i[1]] = float(row)
            return
        self._rows[i] = [float(x) for x in row]

    def __iter__(self):
        return iter([_MatrixRow(self, i) for i in range(len(self._rows))])

    @property
    def row(self):
        return [Vector(r) for r in self._rows]

    @property
    def col(self):
        return [Vector([r[j] for r in self._rows]) for j in range(len(self._rows[0]))]

    @property
    def translation(self):
        return Vector((self._rows[0][3], self._rows[1][3], self._rows[2][3]))

    @translation.setter
    def translation(self, v):
        v = _seq(v)
        for i in range(3):
            self._rows[i][3] = v[i]

    @property
    def is_negative(self):
        return self.to_3x3().determinant() < 0

    @property
    def is_orthogonal(self):
        m = self.to_3x3()
        return (m @ m.transposed()).equals(Matrix.Identity(3), 1e-6)

    @property
    def median_scale(self):
        s = self.to_scale()
        return (abs(s[0]) + abs(s[1]) + abs(s[2])) / 3.0

    def copy(self):
        return Matrix(self._rows)

    __copy__ = copy

    def __deepcopy__(self, memo):
        return self.copy()

    def freeze(self):
        return self

    def identity(self):
        n = len(self._rows)
        self._rows = [[1.0 if i == j else 0.0 for j in range(n)] for i in range(n)]

    def zero(self):
        self._rows = [[0.0] * len(r) for r in self._rows]

    def transposed(self):
        return Matrix([[self._rows[i][j] for i in range(len(self._rows))] for j in range(len(self._rows[0]))])

    def transpose(self):
        self._rows = self.transposed()._rows

    def to_3x3(self):
        return Matrix([[self._rows[i][j] if i < len(self._rows) and j < len(self._rows) else (1.0 if i == j else 0.0) for j in range(3)] for i in range(3)])

    def to_4x4(self):
        m = Matrix.Identity(4)
        for i in range(len(self._rows)):
            for j in range(len(self._rows)):
                m._rows[i][j] = self._rows[i][j]
        return m

    def to_2x2(self):
        return Matrix([r[:2] for r in self._rows[:2]])

    def determinant(self):
        def det(m):
            if len(m) == 1:
                return m[0][0]
            if len(m) == 2:
                return m[0][0] * m[1][1] - m[0][1] * m[1][0]
            return sum(((-1) ** j) * m[0][j] * det([r[:j] + r[j + 1:] for r in m[1:]]) for j in range(len(m)))

        return det(self._rows)

    def inverted(self, fallback=None):
        n = len(self._rows)
        a = [list(r) + [1.0 if i == j else 0.0 for j in range(n)] for i, r in enumerate(self._rows)]
        for c in range(n):
            p = max(range(c, n), key=lambda r: abs(a[r][c]))
            if abs(a[p][c]) < 1e-14:
                if fallback is not None:
                    return fallback
                raise ValueError("Matrix.invert(ed): matrix does not have an inverse")
            a[c], a[p] = a[p], a[c]
            d = a[c][c]
            a[c] = [x / d for x in a[c]]
            for r in range(n):
                if r != c and a[r][c]:
                    f = a[r][c]
                    a[r] = [x - f * y for x, y in zip(a[r], a[c])]
        return Matrix([r[n:] for r in a])

    def invert(self, fallback=None):
        self._rows = self.inverted(fallback)._rows

    def inverted_safe(self):
        return self.inverted(Matrix.Identity(len(self._rows)))

    def invert_safe(self):
        self._rows = self.inverted_safe()._rows

    def normalized(self):
        m = self.copy()
        for j in range(min(3, len(m._rows))):
            col = [m._rows[i][j] for i in range(min(3, len(m._rows)))]
            n = math.sqrt(sum(x * x for x in col))
            if n > _EPS:
                for i in range(min(3, len(m._rows))):
                    m._rows[i][j] /= n
        return m

    def normalize(self):
        self._rows = self.normalized()._rows

    def to_scale(self):
        m = self.to_3x3()._rows
        s = [math.sqrt(sum(m[i][j] ** 2 for i in range(3))) for j in range(3)]
        if self.to_3x3().determinant() < 0:
            s[0] = -s[0]
        return Vector(s)

    def to_translation(self):
        return self.translation

    def _rot(self):
        m = self.to_3x3()._rows
        s = list(self.to_scale())
        return [[m[i][j] / s[j] if abs(s[j]) > _EPS else 0.0 for j in range(3)] for i in range(3)]

    def to_quaternion(self):
        m = self._rot()
        tr = m[0][0] + m[1][1] + m[2][2]
        if tr > 0:
            s = math.sqrt(tr + 1.0) * 2
            q = (0.25 * s, (m[2][1] - m[1][2]) / s, (m[0][2] - m[2][0]) / s, (m[1][0] - m[0][1]) / s)
        elif m[0][0] > m[1][1] and m[0][0] > m[2][2]:
            s = math.sqrt(1.0 + m[0][0] - m[1][1] - m[2][2]) * 2
            q = ((m[2][1] - m[1][2]) / s, 0.25 * s, (m[0][1] + m[1][0]) / s, (m[0][2] + m[2][0]) / s)
        elif m[1][1] > m[2][2]:
            s = math.sqrt(1.0 + m[1][1] - m[0][0] - m[2][2]) * 2
            q = ((m[0][2] - m[2][0]) / s, (m[0][1] + m[1][0]) / s, 0.25 * s, (m[1][2] + m[2][1]) / s)
        else:
            s = math.sqrt(1.0 + m[2][2] - m[0][0] - m[1][1]) * 2
            q = ((m[1][0] - m[0][1]) / s, (m[0][2] + m[2][0]) / s, (m[1][2] + m[2][1]) / s, 0.25 * s)
        q = Quaternion(q).normalized()
        return -q if q[0] < 0 else q

    def to_euler(self, order="XYZ", euler_compat=None):
        m = self._rot()
        idx = {"X": 0, "Y": 1, "Z": 2}
        i, j, k = idx[order[0]], idx[order[1]], idx[order[2]]
        parity = 1 if (j - i) % 3 == 1 else -1
        a = [0.0, 0.0, 0.0]
        sy = -parity * m[k][i]
        cy = math.hypot(m[k][j], m[k][k])
        if cy > 1e-9:
            a[i] = math.atan2(parity * m[k][j], m[k][k])
            a[j] = math.atan2(sy, cy)
            a[k] = math.atan2(parity * m[j][i], m[i][i])
        else:
            a[i] = math.atan2(-parity * m[j][k], m[j][j])
            a[j] = math.atan2(sy, cy)
            a[k] = 0.0
        e = Euler(a, order)
        if euler_compat is not None:
            e.make_compatible(euler_compat)
        return e

    def decompose(self):
        return (self.to_translation(), self.to_quaternion(), self.to_scale())

    def lerp(self, other, factor):
        return Matrix([[a + (b - a) * factor for a, b in zip(r1, r2)] for r1, r2 in zip(self._rows, other._rows)])

    def equals(self, other, eps=1e-6):
        return len(other) == len(self) and all(abs(a - b) <= eps for r1, r2 in zip(self._rows, other._rows) for a, b in zip(r1, r2))

    def __matmul__(self, o):
        if isinstance(o, Matrix):
            n, m, p = len(self._rows), len(o._rows), len(o._rows[0])
            return Matrix([[sum(self._rows[i][k] * o._rows[k][j] for k in range(m)) for j in range(p)] for i in range(n)])
        if isinstance(o, Quaternion):
            return (self.to_3x3() @ o.to_matrix()).to_quaternion()
        v = _seq(o)
        if len(self._rows) == 4 and len(v) == 3:
            r = self._rows
            w = r[3][0] * v[0] + r[3][1] * v[1] + r[3][2] * v[2] + r[3][3]
            w = w if w != 0 else 1.0
            return Vector([(r[i][0] * v[0] + r[i][1] * v[1] + r[i][2] * v[2] + r[i][3]) / w for i in range(3)])
        if len(self._rows) == 3 and len(v) == 4:
            v = v[:3]
        return Vector([sum(a * b for a, b in zip(row, v)) for row in self._rows])

    def __imatmul__(self, o):
        self._rows = (self @ o)._rows
        return self

    def __mul__(self, f):
        if isinstance(f, (int, float)):
            return Matrix([[x * f for x in r] for r in self._rows])
        if isinstance(f, Matrix):
            return Matrix([[a * b for a, b in zip(r1, r2)] for r1, r2 in zip(self._rows, f._rows)])
        return NotImplemented

    __rmul__ = __mul__

    def __add__(self, o):
        return Matrix([[a + b for a, b in zip(r1, r2)] for r1, r2 in zip(self._rows, o._rows)])

    def __sub__(self, o):
        return Matrix([[a - b for a, b in zip(r1, r2)] for r1, r2 in zip(self._rows, o._rows)])

    def __neg__(self):
        return self * -1.0

    def __eq__(self, o):
        return isinstance(o, Matrix) and self._rows == o._rows

    __hash__ = None

    def __repr__(self):
        return "Matrix((%s))" % ",\n        ".join("(%s)" % ", ".join(_fmt(x) for x in r) for r in self._rows)

    def __str__(self):
        return "<Matrix %dx%d %s>" % (len(self._rows), len(self._rows[0]), "\n            ".join("(%s)" % ", ".join("%.4f" % x for x in r) for r in self._rows))


class _Geometry:
    """Subset of mathutils.geometry."""

    @staticmethod
    def intersect_line_plane(line_a, line_b, plane_co, plane_no, no_flip=False):
        a, b = Vector(line_a), Vector(line_b)
        d = b - a
        n = Vector(plane_no)
        den = n.dot(d)
        if abs(den) < _EPS:
            return None
        t = n.dot(Vector(plane_co) - a) / den
        return a + d * t

    @staticmethod
    def intersect_point_line(pt, line_p1, line_p2):
        p, a, b = Vector(pt), Vector(line_p1), Vector(line_p2)
        d = b - a
        l2 = d.length_squared
        t = 0.0 if l2 < _EPS else (p - a).dot(d) / l2
        return (a + d * t, t)

    @staticmethod
    def distance_point_to_plane(pt, plane_co, plane_no):
        return (Vector(pt) - Vector(plane_co)).dot(Vector(plane_no).normalized())

    @staticmethod
    def normal(*vectors):
        if len(vectors) == 1:
            vectors = vectors[0]
        pts = [Vector(v).to_3d() for v in vectors]
        n = Vector((0.0, 0.0, 0.0))
        for i in range(len(pts)):
            a, b = pts[i], pts[(i + 1) % len(pts)]
            n.x += (a.y - b.y) * (a.z + b.z)
            n.y += (a.z - b.z) * (a.x + b.x)
            n.z += (a.x - b.x) * (a.y + b.y)
        return n.normalized()

    @staticmethod
    def area_tri(v1, v2, v3):
        a = Vector(v1)
        c = (Vector(v2) - a).cross(Vector(v3) - a)
        return abs(c) / 2.0 if isinstance(c, float) else c.length / 2.0

    @staticmethod
    def barycentric_transform(point, tri_a1, tri_a2, tri_a3, tri_b1, tri_b2, tri_b3):
        p, a, b, c = Vector(point), Vector(tri_a1), Vector(tri_a2), Vector(tri_a3)
        v0, v1, v2 = b - a, c - a, p - a
        d00, d01, d11, d20, d21 = v0.dot(v0), v0.dot(v1), v1.dot(v1), v2.dot(v0), v2.dot(v1)
        den = d00 * d11 - d01 * d01 or 1.0
        v = (d11 * d20 - d01 * d21) / den
        w = (d00 * d21 - d01 * d20) / den
        u = 1.0 - v - w
        return Vector(tri_b1) * u + Vector(tri_b2) * v + Vector(tri_b3) * w


geometry = _Geometry()


class _Noise:
    """Subset of mathutils.noise (deterministic value noise; original implementation)."""

    def __init__(self):
        import random as _r

        self._rng = _r.Random(0)

    def seed_set(self, seed):
        self._rng.seed(seed)

    def random(self):
        return self._rng.random()

    def random_unit_vector(self, size=3):
        while True:
            v = Vector([self._rng.uniform(-1, 1) for _ in range(size)])
            if 1e-6 < v.length <= 1.0:
                return v.normalized()

    def random_vector(self, size=3):
        return Vector([self._rng.uniform(-1, 1) for _ in range(size)])

    @staticmethod
    def _hash(x, y, z):
        h = (int(x) * 374761393 + int(y) * 668265263 + int(z) * 2147483647) & 0xFFFFFFFF
        h = ((h ^ (h >> 13)) * 1274126177) & 0xFFFFFFFF
        return ((h ^ (h >> 16)) & 0xFFFF) / 65535.0

    def noise(self, position, noise_basis="PERLIN_ORIGINAL"):
        x, y, z = Vector(position).to_3d()
        xi, yi, zi = math.floor(x), math.floor(y), math.floor(z)
        fx, fy, fz = x - xi, y - yi, z - zi
        sx, sy, sz = fx * fx * (3 - 2 * fx), fy * fy * (3 - 2 * fy), fz * fz * (3 - 2 * fz)

        def h(a, b, c):
            return self._hash(xi + a, yi + b, zi + c)

        def lerp(a, b, t):
            return a + (b - a) * t

        v = lerp(
            lerp(lerp(h(0, 0, 0), h(1, 0, 0), sx), lerp(h(0, 1, 0), h(1, 1, 0), sx), sy),
            lerp(lerp(h(0, 0, 1), h(1, 0, 1), sx), lerp(h(0, 1, 1), h(1, 1, 1), sx), sy),
            sz,
        )
        return v * 2.0 - 1.0

    def fractal(self, position, H=1.0, lacunarity=2.0, octaves=4, noise_basis="PERLIN_ORIGINAL"):
        p = Vector(position).to_3d()
        total, amp, norm = 0.0, 1.0, 0.0
        for _ in range(int(octaves)):
            total += self.noise(p) * amp
            norm += amp
            amp *= lacunarity ** (-H)
            p = p * lacunarity
        return total / norm if norm else 0.0


noise = _Noise()
