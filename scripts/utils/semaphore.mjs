class Semaphore {
    constructor() {
      this.busy = false;
      this.waitingQueue = [];
    }

    isBusy() {
        return this.busy;
    }

    async acquire() {
      if (this.busy) {
        await new Promise(resolve => this.waitingQueue.push(resolve));
      }
      this.busy = true;
    }

    release() {
      this.busy = false;
      if (this.waitingQueue.length > 0) {
        const resolve = this.waitingQueue.shift();
        resolve();
      }
    }
  }
export {Semaphore};