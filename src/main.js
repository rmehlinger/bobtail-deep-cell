import _ from 'underscore';
import * as rx from 'bobtail-rx';
import deepGet from 'lodash.get';
import deepSet from 'lodash.set';
import deepHas from 'lodash.hasin';
import cloneDeep from 'lodash.clonedeep';

import patchFactory from 'jsondiffpatch';

let jsondiffpatch = patchFactory.create({
//  objectHash: (obj) -> obj.name or obj.id or obj._id
  cloneDiffValues: true
});

let recorder = rx._recorder;
export let IS_PROXY_SYM = Symbol('is_proxy');

export let patchHas = function(patch, path, diffArray=false) {
  if(_.isString(path)) {
    return patchHas(patch, path.split('.'));  // potentially ambiguous with empty or dot-containing property names
  }
  if(!path.length) {return true;}
  if (_.isArray(patch) && !diffArray) {
    diffArray = true;
    patch = patch[0];
  }

  let [first, ...rest] = path;

  if (_.isObject(patch)) {
    if (!diffArray && patch._t === 'a') {
      let under = `${first}`;
      if(under in patch) {
        return patchHas(patch[under], rest, diffArray);
      }
      else if(first in patch) {
        return patchHas(patch[first], rest, diffArray);
      }
      return false;
    }
    if (!(first in patch)) {
      return false;
    } else if (path.length === 1) {
      return true;
    }
    return patchHas(patch[first], rest, diffArray);
  }
  return false;
};

let prefixDiff = function(basePath, diff) {
  if (!basePath.length) { return diff; }
  let x = {};
  deepSet(x, basePath, diff);
  return x;
};

export function logReturn(x) {
  console.info(x);
  return x;
}

let lengthChange = patchVal =>
  _.isArray(patchVal) && ((patchVal.length === 1) || (patchVal[1] === 0 && patchVal[2] === 0));

export let UPDATE = Symbol('update');

function deleteProperty (getPath, basePath, obj, prop) {
  return rx.snap(() => {
    let path = getPath(prop);
    if (recorder.stack.length > 0) {
      // the default mutation warning is nowhere near dire enough. mutating nested objects within a
      // bind is extremely likely to lead to infinite loops.
      console.warn(
        `Warning: deleting nested element at ${path.join('.')} from within a bind context. Affected object:`, obj
      );
      this.onUnsafeMutation.pub({op: 'delete', path, obj, prop, base: rx.snap(() => this.data)})
    }
    recorder.mutating(() => {
      let old = obj[prop];
      let diff = prefixDiff(basePath, [{[prop]: old}, 0, 0]);
      if(prop in obj) {
        delete obj[prop];
        this.onChange.pub(diff);
      }
    });
    return true;
  })
}

function setProperty (getPath, basePath, obj, prop, val) {
  return rx.snap(() => {
    let path = getPath(prop);
    if (recorder.stack.length > 0) {
      // the default mutation warning is nowhere near dire enough. mutating nested objects within a
      // bind is extremely likely to lead to infinite loops.
      console.warn(
        `Warning: updating nested element at ${path.join('.')} from within a bind context. Affected object:`, obj
      );
      this.onUnsafeMutation.pub({op: 'set', path, obj, prop, val, base: rx.snap(() => this.data)});
    }
    recorder.mutating(() => {
      let old = rx.snap(() => obj[prop]);
      let diff = jsondiffpatch.diff({[prop]: old}, {[prop]: val});
      if (diff) {
        jsondiffpatch.patch(obj, diff);
          this.onChange.pub(prefixDiff(basePath, diff));
      }
    });
    return true;
  })
}

function getProperty(getPath, basePath, obj, prop) {
  let val = obj[prop];
  if (prop === 'IS_PROXY_SYM') {
    return true;
  }
  if (prop === '__proto__' || _.isFunction(obj[prop])) {
    return obj[prop];
  }
  this.subscribeProperty(getPath, obj, prop);
  // return new Proxy(deepGet(this._base, path), this.conf(path, obj));
  if (_.isObject(val)) {
    return new Proxy(val, this.conf(getPath(prop)));
  }
  return val;
}

export class ObsJsonCell extends rx.ObsBase {
  constructor(_base) {
    super();
    this.onChange = this._mkEv(() => jsondiffpatch.diff({}, _base));
    this.onUnsafeMutation = this._mkEv(() => {});
    this._base = {value: _base};
  }

  _proxify() {return new Proxy(this._base, this.conf([]));}

  _updating (f) {
    let _oldUpdating = this._nowUpdating || false;
    this._nowUpdating = true;
    try {rx.snap(f);}
    finally {this._nowUpdating = _oldUpdating;}
    return true;
  }

  _update (newVal) {
    this._updating(() => {
      let diff = jsondiffpatch.diff(this._base, {value: newVal});
      jsondiffpatch.patch(this._proxify(), diff);
    });
    return true;
  }

  all () {return this.data}
  cloneRaw () {return cloneDeep(this._base.value)}
  readonly () {return new DepJsonCell(() => this.data)}

  get data() {return this._proxify().value;}

  mkDeleteProperty (getPath, basePath) {
    return (obj, prop) => this.deleteProperty(getPath, basePath, obj, prop);
  }

  mkSetProperty (getPath, basePath) {
    return (obj, prop, val) => this.setProperty(getPath, basePath, obj, prop, val);
  }

  mkGetProperty (getPath, basePath) {
    return (obj, prop) => this.getProperty(getPath, basePath, obj, prop);
  }

  deleteProperty (getPath, basePath, obj, prop) {
    return deleteProperty.call(this, getPath, basePath, obj, prop);
  }

  setProperty (getPath, basePath, obj, prop, val) {
    return setProperty.call(this, getPath, basePath, obj, prop, val);
  }

  getProperty (getPath, basePath, obj, prop) {
    return getProperty.call(this, getPath, basePath, obj, prop);
  }

  subscribeProperty(getPath, obj, prop) {
    let path = getPath(prop);
    if (prop === 'length' && _.isArray(obj)) {
      let oldVal = obj.length;
      recorder.sub(this.onChange, () => {
        let newVal = rx.snap(() => deepGet(this._base, path));  // necessary because of wrapping in value field
        if(newVal !== oldVal){
          oldVal = newVal;
          return true;
        }
        return false;
      });
    }
    else {
      recorder.sub(this.onChange, patch => patchHas(patch, path));
    }
  }

  _makeReadOnly() {
    let oldSet = this.setProperty;
    this.setProperty = function(getPath, basePath, obj, prop, val) {
      if (!this._nowUpdating) {
        throw new DepMutationError("Cannot mutate DepJsonCell!");
      }
      else return oldSet.call(this, getPath, basePath, obj, prop, val);
    };

    let oldDelete = this.deleteProperty;
    this.deleteProperty = function (getPath, basePath, obj, prop) {
      if (!this._nowUpdating) {
        throw new DepMutationError("Cannot mutate DepJsonCell!");
      }
      else return oldDelete.call(this, getPath, basePath, obj, prop);
    };
    return this;
  }

  conf(basePath) {
    let getPath = (...props) => basePath.concat(props);

    return {
      deleteProperty: this.mkDeleteProperty(getPath, basePath),
      set: this.mkSetProperty(getPath, basePath),
      get: this.mkGetProperty(getPath, basePath),
      has: (obj, prop) => {
      let path = getPath(prop);  // necessary because we wrap within the value field.
      let had = prop in obj;
        recorder.sub(this.onChange, patch => {
          let has = deepHas(this._base, path);
          if (had !== has) {
            had = has;
            return true;
          }
          return false;
        });
        return had;
      },
      ownKeys: obj => {
        recorder.sub(this.onChange, patch => {
          let delta = deepGet(patch, basePath);
          if (!delta) {
            return false;
          }
          // if we added or removed fields on this object
          if (_.isArray(delta && (delta.length !== 2))) {
            return true;
          }
          // true if we added or removed elements to this array, else false
          return (delta._t === 'a') && _.chain(delta).omit('_t').values().value().some();
        });

        return Reflect.ownKeys(obj);
      }
    }
  }
  snapGet(path) {
    return rx.snap(() => deepGet(this.data, path));
  }
}

export class DepMutationError extends Error {
  // https://stackoverflow.com/questions/31089801/extending-error-in-javascript-with-es6-syntax
  constructor(...args) {
    super(...args);
    Error.captureStackTrace(this, DepMutationError)
  }
}

export class DepJsonCell extends ObsJsonCell {
  constructor(f, init = {}) {
    super(init);
    this.f = f;
    let c = rx.bind(this.f);
    rx.autoSub(c.onSet, ([o, n]) => this._update(n));
    this._makeReadOnly();
  }
}

export class SrcJsonCell extends ObsJsonCell {
  constructor (init = {}) {super(init);}
  update(val) {return this._update(val);}
  set data(val) {this._update(val);}
  get data() {return this._proxify().value;}
}

export let jsonCell = _base => new SrcJsonCell(_base).data;

export let update = (cell, newVal) => rx.snap(() => {
  let diff = jsondiffpatch.diff(cell, newVal);
  jsondiffpatch.patch(cell, diff);
  return true;
});