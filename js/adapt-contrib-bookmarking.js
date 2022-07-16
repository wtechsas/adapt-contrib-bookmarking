import Adapt from 'core/js/adapt';
import offlineStorage from 'core/js/offlineStorage';
import logging from 'core/js/logging';
import location from 'core/js/location';
import router from 'core/js/router';
import notify from 'core/js/notify';
import data from 'core/js/data';

class Bookmarking extends Backbone.Controller {

  initialize() {
    this.bookmarkLevel = null;
    this.restoredLocationID = null;
    this.currentLocationID = null;
    this.listenToOnce(Adapt, 'router:location', this.onAdaptInitialize);
  }

  onAdaptInitialize() {
    if (!this.checkCourseIsEnabled()) return;
    this.setupEventListeners();
    this.checkRestoreLocation();
  }

  checkCourseIsEnabled() {
    const courseBookmarkModel = Adapt.course.get('_bookmarking');
    if (!courseBookmarkModel || !courseBookmarkModel._isEnabled) return false;
    return true;
  }

  setupEventListeners() {
    this._onScroll = _.debounce(this.checkLocation.bind(this), 250);
    this.listenTo(Adapt, {
      'menuView:ready': this.setupMenu,
      'pageView:preRender': this.setupPage,
      'view:childAdded': this.checkLocation
    });
  }

  checkRestoreLocation() {
    this.restoredLocationID = offlineStorage.get('location');

    if (!this.restoredLocationID || this.restoredLocationID === 'undefined' || !data.findById(this.restoredLocationID)) {
      return;
    }

    this.listenToOnce(Adapt, 'pageView:ready menuView:ready', this.restoreLocation);
  }

  restoreLocation() {
    this.stopListening(Adapt, 'pageView:ready menuView:ready', this.restoreLocation);

    _.delay(() => {
      if (this.isAlreadyOnScreen(this.restoredLocationID)) {
        return;
      }

      if (Adapt.course.get('_bookmarking')._showPrompt === false) {
        this.navigateToPrevious();
        return;
      }

      this.showPrompt();

    }, 500);// slight delay is necessary to allow any render & scrollTo to complete before calling isAlreadyOnScreen
  }

  /**
   * If the learner is already at the bookmarked location, there's no need to show a prompt
   * This method determines whether that is the case or not
   * @param {string} id The `_id` of the item the learner needs to be returned to
   * @return {boolean}
   */
  isAlreadyOnScreen(id) {
    if (id === location._currentId) return true;

    const type = data.findById(id).getTypeGroup();
    if (type === 'menu' || type === 'page') {
      return false;
    }

    const locationOnscreen = $('.' + id).onscreen();
    const isLocationOnscreen = locationOnscreen && (locationOnscreen.percentInview > 0);
    const isLocationFullyInview = locationOnscreen && (locationOnscreen.percentInview === 100);
    if (isLocationOnscreen && isLocationFullyInview) {
      return true;
    }

    return false;
  }

  showPrompt() {
    const courseBookmarkModel = Adapt.course.get('_bookmarking');
    const buttons = courseBookmarkModel._buttons || { yes: 'Yes', no: 'No' };

    this.listenToOnce(Adapt, {
      'bookmarking:continue': this.navigateToPrevious,
      'bookmarking:cancel': this.navigateCancel
    });

    notify.prompt({
      _classes: 'is-bookmarking',
      _showIcon: true,
      title: courseBookmarkModel.title,
      body: courseBookmarkModel.body,
      _prompts: [
        {
          promptText: buttons.yes || 'Yes',
          _callbackEvent: 'bookmarking:continue'
        },
        {
          promptText: buttons.no || 'No',
          _callbackEvent: 'bookmarking:cancel'
        }
      ]
    });
  }

  navigateToPrevious() {
    _.defer(async () => {
      const isSinglePage = (Adapt.contentObjects.models.length === 1);
      try {
        await router.navigateToElement(this.restoredLocationID, { trigger: true, replace: isSinglePage, duration: 400 });
      } catch (err) {
        logging.warn(`Bookmarking cannot navigate to id: ${this.restoredLocationID}\n`, err);
      }
    });

    this.stopListening(Adapt, 'bookmarking:cancel');
  }

  navigateCancel() {
    this.stopListening(Adapt, 'bookmarking:continue');
  }

  resetLocationID() {
    this.setLocationID('');
  }

  /**
   * if the learner navigates to the top-level menu, clear the stored bookmark
   * if it's a sub-menu, store the menu's id as the bookmark
   */
  setupMenu(menuView) {
    const menuModel = menuView.model;

    if (!menuModel.get('_parentId')) {
      this.resetLocationID();
      return;
    }

    this.setLocationID(menuModel.get('_id'));
  }

  /**
   * Calculates what the bookmarking 'level' will be for any given page.
   * First sets a default using the course-level setting (or 'component' if that's not been set)
   * then checks to see if that's being overridden at page level or not
   * @param {Backbone.Model} pageModel The model for the current page view
   * @return {String} Either 'page', 'block', or 'component' - with 'component' being the default
   */
  getBookmarkLevel(pageModel) {
    const defaultLevel = Adapt.course.get('_bookmarking')._level || 'component';
    const bookmarkModel = pageModel.get('_bookmarking');
    const isInherit = !bookmarkModel || !bookmarkModel._level || bookmarkModel._level === 'inherit';
    return isInherit ? defaultLevel : bookmarkModel._level;
  }

  /**
   * Sets up bookmarking for the page the learner just navigated to
   * If bookmarking is disabled for the current page, clear the stored bookmark and return.
   * Otherwise, bookmark the page then - if necessary - set up to calculate which block or component
   * should be bookmarked as the learner scrolls up/down the page
   * @param {Backbone.View} pageView The current page view
   */
  setupPage(pageView) {
    const pageBookmarkModel = pageView.model.get('_bookmarking');
    if (pageBookmarkModel?._isEnabled === false) {
      this.resetLocationID();
      return;
    }

    this.setLocationID(pageView.model.get('_id'));

    this.bookmarkLevel = this.getBookmarkLevel(pageView.model);
    if (this.bookmarkLevel === 'page') {
      return;
    }

    this.listenToOnce(Adapt, 'remove', this.releaseViews);

    $(window).on('scroll', this._onScroll);
  }

  setLocationID(id) {
    if (this.currentLocationID === id) return;
    offlineStorage.set('location', id);
    this.currentLocationID = id;
  }

  releaseViews() {
    this.stopListening(Adapt, 'remove', this.releaseViews);
    $(window).off('scroll', this._onScroll);
  }

  checkLocation() {
    const contentObjectBookmarkModel = Adapt.parentView?.model?.get('_bookmarking');
    if (contentObjectBookmarkModel?._isEnabled === false) {
      this.resetLocationID();
      return;
    }
    const currentModel = location._currentModel;
    if (!currentModel || !this.bookmarkLevel) return;
    const possibleViewIds = currentModel.findDescendantModels(this.bookmarkLevel)
      .filter(desc => desc.get('_isTrackable') !== false) // Filter trickle buttons
      .map(desc => desc.get('_id'));

    let highestOnscreen = 0;
    let highestOnscreenLocation = '';
    possibleViewIds.forEach(id => {
      const element = $(`[data-adapt-id=${id}]`);
      if (!element.length) return;
      const measurements = element.onscreen();
      if (!measurements.onscreen) return;
      if (measurements.percentInview <= highestOnscreen) return;
      highestOnscreen = measurements.percentInview;
      highestOnscreenLocation = id;
    });

    // set location as most inview component
    if (highestOnscreenLocation) this.setLocationID(highestOnscreenLocation);
  }
}

export default new Bookmarking();
