'use strict';

const Homey = require('homey');

class CZSpotPricesApp extends Homey.App {

  /**
   * onInit is called when the app is initialized.
   * This is the entry point for your app, where you can set up 
   * anything that needs to be initialized when the app starts.
   */
  async onInit() {
    this.log('CZSpotPricesApp has been initialized');

    // Initialize global listeners or services
    this.initializeGlobalListeners();
  }

  /**
   * Initializes any global event listeners or services that the app needs.
   * This method can be used to set up any recurring tasks, listeners, 
   * or external integrations that should be active throughout the app's lifecycle.
   */
  initializeGlobalListeners() {
    // Example: Listening for a global event
    // this.homey.on('someEvent', this.handleSomeEvent.bind(this));

    // Example: Set up a recurring task
    // this.homey.setInterval(this.someRecurringTask.bind(this), 10000); // Run every 10 seconds

    this.log('Global listeners have been initialized');
  }

  /**
   * Handles a specific event that the app is listening for.
   * This is just an example of how you might structure event handling.
   */
  async handleSomeEvent(data) {
    this.log('Handling some event with data:', data);

    // Process the event data here
  }

  /**
   * Example of a recurring task that could be set up in initializeGlobalListeners.
   * This is just an example method to illustrate how you might set up recurring logic.
   */
  async someRecurringTask() {
    this.log('Running some recurring task');

    // Add logic for the recurring task here
  }

}

module.exports = CZSpotPricesApp;
