class Queue {
    constructor() {
        this._stack1 = [];
        this._stack2 = [];
    }

    push(item) {
      this._stack1.push(item);
    }

    shift() {
      if (this._stack2.length === 0) {
        this._stack2 = this._stack1.reverse();
        this._stack1 = [];
      }
      return this._stack2.pop();
    }

    get length() {
      return this._stack1.length + this._stack2.length;
    }

    qsort() {
      this._stack1 =  this._stack1.concat(this._stack2);
      this._stack2 = [];
      this._stack1.sort((a, b) => a.timestamp - b.timestamp );
      console.log("sorted queue : ", this._stack1);
    }
  };
  
  export { Queue };