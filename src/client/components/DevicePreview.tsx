import * as React from 'react';
import { StyleSheet, css } from 'aphrodite';
import classnames from 'classnames';
import isEqual from 'lodash/isEqual';
import ButtonLink from './shared/ButtonLink';
import Button from './shared/Button';
import ModalAuthentication from './Auth/ModalAuthentication';
import Segment from '../utils/Segment';
import constructAppetizeURL from '../utils/constructAppetizeURL';
import { SDKVersion } from '../configs/sdk';
import colors from '../configs/colors';
import constants from '../configs/constants';
import withAuth, { AuthProps } from '../auth/withAuth';
import withThemeName, { ThemeName } from './Preferences/withThemeName';
import { Viewer } from '../types';
import ToggleButtons from './shared/ToggleButtons';

export const VISIBILITY_MEDIA_QUERY = '(min-width: 700px)';

type Props = AuthProps & {
  sdkVersion: SDKVersion;
  channel: string;
  platform: 'ios' | 'android';
  onChangePlatform: (platform: 'android' | 'ios') => void;
  canUserAuthenticate: boolean;
  wasUpgraded: boolean;
  previewQueue: 'main' | 'secondary';
  snackId?: string;
  className?: string;
  screenOnly?: boolean;
  payerCode?: string;
  onClickRunOnPhone: () => void;
  theme: ThemeName;
};

type AppetizeStatus =
  | {
      type: 'unknown';
    }
  | {
      type: 'requested';
    }
  | {
      type: 'queued';
      position: number | undefined;
    }
  | {
      type: 'connecting';
    }
  | {
      type: 'launch';
    }
  | {
      type: 'timeout';
    };

type PayerCodeFormStatus =
  | {
      type: 'open';
      value: string;
    }
  | {
      type: 'submitted';
    }
  | {
      type: 'closed';
    };

type State = {
  initialId: string | undefined;
  isRendered: boolean;
  isLoggingIn: boolean;
  payerCodeFormStatus: PayerCodeFormStatus;
  appetizeStatus: AppetizeStatus;
  autoplay: boolean;
  isPopupOpen: boolean;
  viewer: Viewer | undefined;
  platform: 'ios' | 'android';
  sdkVersion: SDKVersion;
};

class DevicePreview extends React.PureComponent<Props, State> {
  static getDerivedStateFromProps(props: Props, state: State) {
    // Reset appetize status when we change platform or sdk version or user logs in
    if (
      props.platform !== state.platform ||
      props.sdkVersion !== state.sdkVersion ||
      (props.viewer !== state.viewer &&
        props.viewer &&
        props.viewer.user_metadata &&
        props.viewer.user_metadata.appetize_code)
    ) {
      return {
        appetizeStatus: { type: 'unknown' },
        payerCodeFormStatus: { type: 'closed' },
        autoplay: state.payerCodeFormStatus.type === 'submitted',
        platform: props.platform,
        sdkVersion: props.sdkVersion,
        viewer: props.viewer,
      };
    }

    return null;
  }

  state: State = {
    initialId: this.props.wasUpgraded ? undefined : this.props.snackId,
    isRendered: false,
    isLoggingIn: false,
    payerCodeFormStatus: { type: 'closed' },
    appetizeStatus: { type: 'unknown' },
    autoplay: false,
    isPopupOpen: false,
    viewer: this.props.viewer,
    platform: this.props.platform,
    sdkVersion: this.props.sdkVersion,
  };

  componentDidMount() {
    this._mql = window.matchMedia(VISIBILITY_MEDIA_QUERY);
    this._mql.addListener(this._handleMediaQuery);
    this._handleMediaQuery(this._mql);

    window.addEventListener('message', this._handlePostMessage);
    window.addEventListener('unload', this._endSession);
  }

  componentDidUpdate(prevProps: Props, prevState: State) {
    if (
      prevState.appetizeStatus !== this.state.appetizeStatus &&
      this.state.appetizeStatus.type === 'requested'
    ) {
      this._handleLaunchRequest();
    } else if (
      this.state.isPopupOpen &&
      !isEqual(
        this._getAppetizeOptions(prevProps, prevState),
        this._getAppetizeOptions(this.props, this.state)
      )
    ) {
      this._handlePopup();
    }
  }

  componentWillUnmount() {
    this._endSession();

    clearInterval(this._popupInterval);

    window.removeEventListener('message', this._handlePostMessage);
    window.removeEventListener('unload', this._endSession);

    this._mql && this._mql.removeListener(this._handleMediaQuery);

    if (this._popup) {
      this._popup.close();
    }
  }

  _handleLaunchRequest = () => {
    Segment.getInstance().logEvent('RAN_EMULATOR');
  };

  _handleMediaQuery = (mql: any) =>
    this.setState({
      isRendered: mql.matches,
    });

  _handlePayerCodeLink = () => {
    this.setState({
      payerCodeFormStatus: { type: 'open', value: '' },
    });
    Segment.getInstance().logEvent('REQUESTED_APPETIZE_CODE', {}, 'previewQueue');
  };

  _handlePostMessage = ({ origin, data }: MessageEvent) => {
    if (origin === constants.appetize.url) {
      let status: AppetizeStatus | undefined;

      if (this._waitingForMessage) {
        clearInterval(this._waitingForMessage);
        this._waitingForMessage = null;
      }

      switch (data) {
        case 'sessionRequested':
          status = { type: 'requested' };
          break;
        case 'sessionConnecting':
          status = { type: 'connecting' };
          break;
        case 'appLaunch':
          status = { type: 'launch' };
          if (this.state.appetizeStatus.type === 'queued') {
            Segment.getInstance().logEvent('APP_LAUNCHED', {}, 'previewQueue');
          }
          Segment.getInstance().clearTimer('previewQueue');
          break;
        case 'timeoutWarning':
          status = { type: 'timeout' };
          break;
        case 'sessionEnded':
          status = { type: 'unknown' };
          Segment.getInstance().clearTimer('previewQueue');
          break;
        case 'accountQueued':
          status = { type: 'queued', position: undefined };
          break;
        default:
          if (data && data.type === 'accountQueuedPosition') {
            status = { type: 'queued', position: data.position };
            if (
              this.state.appetizeStatus.type !== 'queued' ||
              !this.state.appetizeStatus.position
            ) {
              Segment.getInstance().logEvent('QUEUED_FOR_PREVIEW', {
                queuePosition: status.position,
              });
              Segment.getInstance().startTimer('previewQueue');
            }
          }
      }

      if (status) {
        this.setState({
          appetizeStatus: status,
        });
      }
    }
  };

  _handlePayerCodeChange = (e: React.ChangeEvent<HTMLInputElement>) =>
    this.setState({
      payerCodeFormStatus: { type: 'open', value: e.target.value },
    });

  _handlePayerCodeSubmit = (e: React.FormEvent<HTMLFormElement>) => {
    e.preventDefault();

    if (this.props.viewer) {
      this._savePayerCode();
    } else {
      this.setState({
        isLoggingIn: true,
      });
    }

    Segment.getInstance().logEvent('ENTERED_APPETIZE_CODE', {}, 'previewQueue');
  };

  _handleDismissAuthModal = () => this.setState({ isLoggingIn: false });

  _handleAuthComplete = () => {
    this.setState({
      isLoggingIn: false,
    });

    this._savePayerCode();
  };

  _savePayerCode = () => {
    const { payerCodeFormStatus } = this.state;

    if (payerCodeFormStatus.type !== 'open' || !payerCodeFormStatus.value) {
      return;
    }

    this.props.setMetadata({
      appetizeCode: payerCodeFormStatus.value,
    });

    this.setState({
      payerCodeFormStatus: { type: 'submitted' },
    });
  };

  _getAppetizeOptions = (props: Props, state: State) => {
    const { sdkVersion, channel, platform, screenOnly, previewQueue, payerCode, viewer } = props;
    const { autoplay, initialId } = state;

    return {
      sdkVersion,
      channel,
      platform,
      screenOnly,
      previewQueue,
      payerCode,
      viewer,
      autoplay,
      initialId,
    };
  };

  _getAppetizeURL = () => {
    const {
      sdkVersion,
      channel,
      platform,
      screenOnly,
      payerCode,
      viewer,
      autoplay,
      initialId,
      previewQueue,
    } = this._getAppetizeOptions(this.props, this.state);

    return constructAppetizeURL({
      sdkVersion,
      channel,
      autoplay,
      snackId: initialId,
      platform,
      previewQueue,
      screenOnly,
      deviceColor: this.props.theme === 'dark' ? 'white' : 'black',
      scale: screenOnly ? (platform === 'android' ? 80 : 76) : undefined,
      payerCode:
        viewer && viewer.user_metadata && viewer.user_metadata.appetize_code
          ? viewer.user_metadata.appetize_code
          : payerCode,
    });
  };

  _handlePopup = () => {
    const url = this._getAppetizeURL();

    this._popup = window.open(url, 'appetize', 'width=327,height=668');

    if (this._popup && this._popup.closed) {
      return;
    }

    this.setState({
      isPopupOpen: true,
    });

    clearInterval(this._popupInterval);

    this._popupInterval = setInterval(() => {
      if (!this._popup || this._popup.closed) {
        clearInterval(this._popupInterval);
        this._popup = null;
        this.setState({
          isPopupOpen: false,
        });
      }
    }, 500);
  };

  _popupInterval: any;
  _popup: Window | null = null;
  _mql: MediaQueryList | null = null;

  _iframe = React.createRef<HTMLIFrameElement>();
  _waitingForMessage: any;

  _onTapToPlay = () => {
    if (this._waitingForMessage) {
      return;
    }

    // Attempt to start the session immediately
    this._requestSession();
    // Keep asking for a session every second until something is posted from the
    // iframe This handles the edge case where the iframe hasn't loaded and
    // isn't ready to receive events.
    this._waitingForMessage = setInterval(this._requestSession, 1000);
  };

  _requestSession = () => {
    if (this._iframe.current && this._iframe.current.contentWindow) {
      this._iframe.current.contentWindow.postMessage('requestSession', '*');
    }
  };

  _endSession = () => {
    if (this._iframe.current && this._iframe.current.contentWindow) {
      this._iframe.current.contentWindow.postMessage('endSession', '*');
    }
  };

  _renderButtons = () => {
    return (
      <div
        className={
          this.props.screenOnly
            ? css(styles.buttonContainerEmbedded)
            : css(
                styles.buttonContainer,
                this.props.platform === 'ios'
                  ? styles.buttonContainerIOS
                  : styles.buttonContainerAndroid
              )
        }>
        {this.props.wasUpgraded ? (
          <div style={{ top: 90 }} className={css(styles.warningText)}>
            This Snack was written in an SDK version that is not longer supported and has been
            automatically upgraded.
          </div>
        ) : null}
        <a className={css(styles.buttonLink)} style={{ top: 160 }} onClick={this._onTapToPlay}>
          <div className={css(styles.buttonFrame)}>
            <span className={css(styles.buttonText)}>Tap to play</span>
          </div>
        </a>
        {this.state.isPopupOpen ? null : (
          <a
            className={css(styles.buttonLink)}
            style={{ top: 250 }}
            onClick={this.props.onClickRunOnPhone}>
            <div className={css(styles.buttonFrame)}>
              <span className={css(styles.buttonText)}>Run on your device</span>
            </div>
          </a>
        )}
      </div>
    );
  };

  render() {
    if (!this.state.isRendered || this.state.isPopupOpen) {
      return null;
    }

    const { platform, screenOnly, onChangePlatform, theme } = this.props;

    const url = this._getAppetizeURL();

    return (
      <div
        className={classnames(
          css(screenOnly ? styles.centered : styles.container),
          this.props.className
        )}>
        {screenOnly ? null : (
          <div className={css(styles.header)}>
            <ToggleButtons
              options={[{ label: 'Android', value: 'android' }, { label: 'iOS', value: 'ios' }]}
              value={platform}
              onValueChange={onChangePlatform}
              className={css(styles.toggleButtons)}
            />
            <button
              className={css(
                styles.popupButton,
                theme === 'dark' ? styles.popupButtonDark : styles.popupButtonLight
              )}
              onClick={this._handlePopup}
            />
          </div>
        )}
        <div className={css(screenOnly ? styles.screen : styles.device)}>
          <iframe
            ref={this._iframe}
            key={url + this.props.sdkVersion}
            src={url}
            className={css(styles.frame)}
          />
          {this.state.appetizeStatus.type === 'unknown' ? this._renderButtons() : null}
        </div>
        {this.state.appetizeStatus.type === 'queued' ? (
          <div className={css(styles.queueModal, styles.centered)}>
            <div className={css(styles.queueModalContent)}>
              <h4>Device preview is at capacity</h4>
              <p>Queue position: {this.state.appetizeStatus.position || 1}</p>
              <h3>Don't want to wait?</h3>
              {this.props.canUserAuthenticate ? (
                <div>
                  <p>Use a free Appetize.io account</p>
                  <div className={css(styles.payerCodeForm)}>
                    {this.state.payerCodeFormStatus.type === 'open' ? (
                      <form onSubmit={this._handlePayerCodeSubmit}>
                        <input
                          type="text"
                          value={this.state.payerCodeFormStatus.value}
                          onChange={this._handlePayerCodeChange}
                          className={css(styles.payerCodeInput)}
                        />
                        <Button
                          type="submit"
                          variant="primary"
                          className={css(styles.button, styles.activateButton)}>
                          Activate
                        </Button>
                      </form>
                    ) : this.state.payerCodeFormStatus.type === 'submitted' ? (
                      <p className={css(styles.payerCodeSubmitted)}>Payer code saved to profile!</p>
                    ) : (
                      <ButtonLink
                        variant="primary"
                        href={`${constants.appetize.url}/payer-code`}
                        onClick={this._handlePayerCodeLink}
                        target="_blank"
                        className={css(styles.button, styles.blockButton)}>
                        Use Appetize.io
                      </ButtonLink>
                    )}
                  </div>
                  <p>or</p>
                </div>
              ) : null}

              <ButtonLink
                variant="primary"
                onClick={this.props.onClickRunOnPhone}
                className={css(styles.button, styles.blockButton)}>
                Run it on your phone
              </ButtonLink>
            </div>
          </div>
        ) : null}
        <ModalAuthentication
          visible={this.state.isLoggingIn}
          onDismiss={this._handleDismissAuthModal}
          onComplete={this._handleAuthComplete}
        />
      </div>
    );
  }
}

export default withThemeName(withAuth(DevicePreview));

const styles = StyleSheet.create({
  container: {
    position: 'relative',
    padding: '0 16px',
    maxWidth: '50%',
    overflow: 'auto',
    display: 'none',

    [`@media ${VISIBILITY_MEDIA_QUERY}`]: {
      display: 'block',
    },
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    margin: '8px 0',
  },
  toggleButtons: {
    zIndex: 3,
  },
  popupButton: {
    position: 'absolute',
    right: 0,
    zIndex: 2,
    appearance: 'none',
    height: 48,
    width: 48,
    padding: 16,
    margin: 0,
    border: 0,
    outline: 0,
    opacity: 0.8,
    backgroundSize: 16,
    backgroundPosition: 'center',
    backgroundRepeat: 'no-repeat',
    backgroundColor: 'transparent',
    transition: '.2s',

    ':hover': {
      opacity: 1,
    },
  },
  popupButtonDark: {
    backgroundImage: `url(${require('../assets/open-link-icon-light.png')})`,
  },
  popupButtonLight: {
    backgroundImage: `url(${require('../assets/open-link-icon.png')})`,
  },
  loading: {
    position: 'absolute',
    top: 0,
    left: 0,
    bottom: 0,
    right: 0,
    zIndex: 1,
  },
  centered: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'auto',
  },
  device: {
    position: 'relative',
    height: 653,
    width: 324,
    overflow: 'hidden',
    margin: 'auto',
    zIndex: 2,
  },
  screen: {
    position: 'relative',
    height: 508,
    width: 285,
    overflow: 'hidden',
    margin: 'auto',
    zIndex: 2,
  },
  frame: {
    width: 9999,
    height: 9999,
    border: 0,
    overflow: 'hidden',
  },
  queueModal: {
    color: 'white',
    backgroundColor: 'rgba(36, 43, 56, 0.8)',
    position: 'absolute',
    zIndex: 2,
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    padding: 28,
  },
  queueModalContent: {
    textAlign: 'center',
  },
  qrcode: {
    margin: '21px 7px',
    height: 208,
    width: 208,
    backgroundColor: '#fff',
    border: '4px solid #fff',
    borderRadius: 3,
  },
  buttons: {
    display: 'flex',
    flexDirection: 'row',
  },
  button: {
    backgroundRepeat: 'no-repeat',
    backgroundPosition: '.5em center',
  },
  buttonPadding: {
    paddingLeft: '24px',
  },
  downloadButton: {
    flex: 1,
  },
  blockButton: {
    cursor: 'pointer',
    display: 'block',
    flex: 1,
  },
  activateButton: {
    ':only-of-type': {
      marginLeft: 0,
      marginRight: 0,
      borderBottomLeftRadius: 0,
      borderTopLeftRadius: 0,
    },
  },
  playstore: {
    backgroundImage: `url(${require('../assets/play-store-icon.png')})`,
    backgroundSize: '20px 23px',
    paddingLeft: 21,
    paddingRight: 7,
  },
  appstore: {
    backgroundImage: `url(${require('../assets/app-store-icon.png')})`,
    backgroundSize: '12px 23px',
  },
  payerCodeForm: {
    height: 50,
    display: 'flex',
    flexDirection: 'row',
  },
  payerCodeInput: {
    fontFamily: 'var(--font-monospace)',
    padding: 7,
    marginRight: -1,
    borderTopLeftRadius: 3,
    borderBottomLeftRadius: 3,
    width: 133,
    border: `1px solid ${colors.border}`,
    color: colors.text.light,
  },
  payerCodeSubmitted: {
    margin: '0 auto',
    padding: 14,
    textAlign: 'center',
    color: colors.success,
  },
  buttonContainer: {
    position: 'absolute',
    top: 0,
    left: 0,
    bottom: 0,
  },
  buttonContainerAndroid: {
    right: 24,
  },
  buttonContainerIOS: {
    right: 12,
  },
  buttonContainerEmbedded: {
    position: 'absolute',
    top: -70,
    left: 0,
    right: 0,
    bottom: 0,
  },
  warningText: {
    color: 'white',
    fontSize: '12px',
    left: 20,
    position: 'absolute',
    width: '90%',
    paddingLeft: '20px',
    paddingRight: '20px',
    textAlign: 'center',
  },
  buttonLink: {
    position: 'absolute',
    left: 0,
    right: 0,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    cursor: 'pointer',
  },
  buttonFrame: {
    height: 70,
    width: 225,
    backgroundColor: colors.content.light,
    borderRadius: 30,
    alignItems: 'center',
    justifyContent: 'center',
    display: 'flex',
    paddingLeft: 20,
    paddingRight: 20,
  },
  buttonText: {
    color: colors.content.dark,
    fontSize: 20,
    fontWeight: 400,
  },
});
