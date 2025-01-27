'use strict';

const React = require('react');
const areEqual = require('fbjs/lib/areEqual');
const deepFreeze = require('deep-freeze');
const {ReactRelayContext} = require('react-relay');

import type {CacheConfig, Disposable} from 'RelayCombinedEnvironmentTypes';
import type {RelayEnvironmentInterface as ClassicEnvironment} from 'RelayEnvironment';
import type {GraphQLTaggedNode} from 'RelayModernGraphQLTag';
import type {
    Environment,
    OperationSelector,
    RelayContext,
    Snapshot,
} from 'RelayStoreTypes';
import type {RerunParam, Variables} from 'RelayTypes';

export type Props = {
    cacheConfig?: ?CacheConfig,
    environment: Environment | ClassicEnvironment,
    query: ?GraphQLTaggedNode,
    render: (readyState: ReadyState) => ?React.Element<any>,
    variables: Variables,
    rerunParamExperimental?: RerunParam,
};
export type ReadyState = {
    error: ?Error,
    props: ?Object,
    retry: ?() => void,
};
type State = {
    readyState: ReadyState,
};

/**
 * @public
 *
 * Orchestrates fetching and rendering data for a single view or view hierarchy:
 * - Fetches the query/variables using the given network implementation.
 * - Normalizes the response(s) to that query, publishing them to the given
 *   store.
 * - Renders the pending/fail/success states with the provided render function.
 * - Subscribes for updates to the root data and re-renders with any changes.
 */
class ReactRelayQueryRenderer extends React.Component<Props, State> {
    _pendingFetch: ?Disposable;
    _relayContext: RelayContext;
    _rootSubscription: ?Disposable;
    _selectionReference: ?Disposable;

    constructor(props: Props) {
        super(props);
        this._pendingFetch = null;
        this._rootSubscription = null;
        this._selectionReference = null;

        this.state = {
            readyState: this._fetchForProps(props),
        };
    }

    componentWillReceiveProps(nextProps: Props): void {
        if (
            nextProps.query !== this.props.query ||
            nextProps.environment !== this.props.environment ||
            !areEqual(nextProps.variables, this.props.variables)
        ) {
            this.setState({
                readyState: this._fetchForProps(nextProps),
            });
        }
    }

    componentWillUnmount(): void {
        this._release();
    }

    shouldComponentUpdate(nextProps: Props, nextState: State): boolean {
        return (
            nextProps.render !== this.props.render ||
            nextState.readyState !== this.state.readyState
        );
    }

    _release(): void {
        if (this._pendingFetch) {
            this._pendingFetch.dispose();
            this._pendingFetch = null;
        }
        if (!this.props.retain && this._rootSubscription) {
            this._rootSubscription.dispose();
            this._rootSubscription = null;
        }
        if (!this.props.retain && this._selectionReference) {
            this._selectionReference.dispose();
            this._selectionReference = null;
        }
    }

    _fetchForProps(props: Props): ReadyState {
        // TODO (#16225453) QueryRenderer works with old and new environment, but
        // the flow typing doesn't quite work abstracted.
        // $FlowFixMe
        const environment: Environment = props.environment;

        const {query, variables} = props;
        if (query) {
            const {
                createOperationDescriptor,
                getRequest,
            } = environment.unstable_internal;
            const operation = createOperationDescriptor(getRequest(query), variables);
            this._relayContext = {
                environment,
                variables: operation.variables,
            };
            if (props.lookup && environment.check(operation.root)) {
                this._selectionReference = environment.retain(operation.root);

                // data is available in the store, render without making any requests
                const snapshot = environment.lookup(operation.fragment, operation);
                this._rootSubscription = environment.subscribe(snapshot, this._onChange);

                return {
                    error: null,
                    props: snapshot.data,
                    retry: () => {
                        this._fetch(operation, props.cacheConfig);
                    },
                };
            } else {
                return this._fetch(operation, props.cacheConfig) || getDefaultState();
            }
        } else {
            this._relayContext = {
                environment,
                variables,
            };
            this._release();
            return {
                error: null,
                props: {},
                retry: null,
            };
        }
    }

    _fetch(operation: OperationSelector, cacheConfig: ?CacheConfig): ?ReadyState {
        const {environment} = this._relayContext;

        // Immediately retain the results of the new query to prevent relevant data
        // from being freed. This is not strictly required if all new data is
        // fetched in a single step, but is necessary if the network could attempt
        // to incrementally load data (ex: multiple query entries or incrementally
        // loading records from disk cache).
        const nextReference = environment.retain(operation.root);

        let readyState = getDefaultState();
        let snapshot: ?Snapshot; // results of the root fragment
        let hasSyncResult = false;
        let hasFunctionReturned = false;

        if (this._pendingFetch) {
            this._pendingFetch.dispose();
        }
        if (!this.props.retain && this._rootSubscription) {
            this._rootSubscription.dispose();
        }

        const request = environment
            .execute({operation, cacheConfig})
            .finally(() => {
                this._pendingFetch = null;
            })
            .subscribe({
                next: () => {
                    // `next` can be called multiple times by network layers that support
                    // data subscriptions. Wait until the first payload to render `props`
                    // and subscribe for data updates.
                    if (snapshot) {
                        return;
                    }
                    snapshot = environment.lookup(operation.fragment, operation);
                    readyState = {
                        error: null,
                        props: snapshot.data,
                        retry: () => {
                            // Do not reset the default state if refetching after success,
                            // handling the case where _fetch may return syncronously instead
                            // of calling setState.
                            const syncReadyState = this._fetch(operation, cacheConfig);
                            if (syncReadyState) {
                                this.setState({readyState: syncReadyState});
                            }
                        },
                    };

                    if (!this.props.retain && this._selectionReference) {
                        this._selectionReference.dispose();
                    }
                    this._rootSubscription = environment.subscribe(
                        snapshot,
                        this._onChange,
                    );
                    this._selectionReference = nextReference;
                    // This line should be called only once.
                    hasSyncResult = true;
                    if (hasFunctionReturned) {
                        this.setState({readyState});
                    }
                },
                error: error => {
                    readyState = {
                        error,
                        props: null,
                        retry: () => {
                            // Return to the default state when retrying after an error,
                            // handling the case where _fetch may return syncronously instead
                            // of calling setState.
                            const syncReadyState = this._fetch(operation, cacheConfig);
                            this.setState({readyState: syncReadyState || getDefaultState()});
                        },
                    };
                    if (this._selectionReference) {
                        this._selectionReference.dispose();
                    }
                    this._selectionReference = nextReference;
                    hasSyncResult = true;
                    if (hasFunctionReturned) {
                        this.setState({readyState});
                    }
                },
            });

        this._pendingFetch = {
            dispose() {
                request.unsubscribe();
                nextReference.dispose();
            },
        };
        hasFunctionReturned = true;
        return hasSyncResult ? readyState : null;
    }

    _onChange = (snapshot: Snapshot): void => {
        this.setState({
            readyState: {
                ...this.state.readyState,
                props: snapshot.data,
            },
        });
    };

    render() {
        // Note that the root fragment results in `readyState.props` is already
        // frozen by the store; this call is to freeze the readyState object and
        // error property if set.
        // if (__DEV__) {
        //     deepFreeze(this.state.readyState);
        // }
        return (
            <ReactRelayContext.Provider value={this._relayContext}>
                {this.props.render(this.state.readyState)}
            </ReactRelayContext.Provider>
        );
    }
}

function getDefaultState(): ReadyState {
    return {
        error: null,
        props: null,
        retry: null,
    };
}

module.exports = ReactRelayQueryRenderer;
