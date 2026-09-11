/**
 * dsh-molbio-tools/test/slots-stub.mjs
 *
 * A faithful-enough stand-in for the shell's client slot registry (`SlotCore`
 * in `dsh-web-frontend/dist`), shared by the client tests.
 *
 * Two rules are modelled because the panel broke on them in production:
 *
 * 1. `register()` is only legal for a seat that EXISTS. The shell throws
 *
 *      slot "<name>" is not declared (a parent entry's children table must
 *      declare it)
 *
 *    for anything else: a seat comes into existence when the entry that owns it
 *    declares it in its `children` table (`sidebar.right.pane.tab` is declared
 *    by the right sidebar, `tool.call.toolview` is a CHILD of ui-tool's
 *    `conversation.chat.node` entry). A throwing registration escapes the
 *    registrant's `apply()` and fails that plugin's LOADER entry.
 * 2. `inject(seat, callback)` waits for the declaration instead of racing it:
 *    the callback runs synchronously when the seat exists, after `declare()`
 *    when it does not, and again after every RE-declaration (the shell's
 *    declaration-epoch rule), with the previous contributions disposed first.
 *    Its return value is a disposer or an iterable of disposers.
 *
 * The stub keeps no opinion about slot kinds (`single`/`keyed`/`list`/`chain`):
 * these tests are about whether a claim reaches a declared seat at all.
 */

/**
 * @param seats - seat names that are already declared when the plugin applies.
 * @returns a stub exposing `register`, `inject`, `declare`, `registrations`,
 *          `injectedSeats` and `pendingSeats`.
 */
export function createSlotsStub(seats = []) {
  const declared = new Set(seats);
  /** Registration records, in the order they were accepted. */
  const registrations = [];
  /** seat -> [{ callback, disposers }] in inject order. */
  const waits = new Map();

  /** Run one waiter's callback, replacing whatever it contributed before. */
  const activate = (waiter) => {
    for (const dispose of waiter.disposers.splice(0)) dispose();
    const result = waiter.callback();
    const disposers = typeof result === 'function'
      ? [result]
      : Array.isArray(result) || (result !== null && typeof result === 'object')
        ? [...result]
        : [];
    for (const dispose of disposers) {
      if (typeof dispose !== 'function') throw new TypeError('a slot contribution must return a function or an iterable of functions');
      waiter.disposers.push(dispose);
    }
  };

  return {
    /** Every accepted registration, in acceptance order. */
    registrations,
    /** Every seat this plugin has waited on, in first-inject order. */
    get injectedSeats() {
      return [...waits.keys()];
    },
    /** Waited-on seats that are still undeclared (the shell's waiting state). */
    get pendingSeats() {
      return [...waits.keys()].filter((seat) => !declared.has(seat));
    },
    /** Declare a seat (an entry's `children` table landing) and release waiters. */
    declare(seat) {
      declared.add(seat);
      for (const waiter of waits.get(seat) ?? []) activate(waiter);
    },
    register(registration, component) {
      const seat = registration?.name;
      if (!declared.has(seat)) {
        throw new Error(`slot "${seat}" is not declared (a parent entry's children table must declare it)`);
      }
      const entry = { registration, component };
      registrations.push(entry);
      return () => {
        const index = registrations.indexOf(entry);
        if (index !== -1) registrations.splice(index, 1);
      };
    },
    inject(seat, callback) {
      const waiter = { callback, disposers: [] };
      const list = waits.get(seat);
      if (list === undefined) waits.set(seat, [waiter]);
      else list.push(waiter);
      if (declared.has(seat)) activate(waiter);
      return () => {
        for (const dispose of waiter.disposers.splice(0)) dispose();
      };
    },
  };
}
