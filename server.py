from flask import Flask, request, jsonify, send_from_directory
import pandas as pd
import os

app = Flask(__name__, static_folder='.')

@app.route('/')
def index():
    return send_from_directory('.', 'index.module.html')

@app.route('/<path:path>')
def static_proxy(path):
    return send_from_directory('.', path)

@app.route('/api/query', methods=['POST'])
def query():
    data = request.json
    csv_file = data.get('csv', 'demo.csv')
    query = data.get('query')
    try:
        df = pd.read_csv(csv_file)
        # For demo: only allow simple filter and projection
        if query and 'where' in query.lower():
            # Example: SELECT id, name FROM demo WHERE age >= 30
            import re
            m = re.match(r'SELECT (.+) FROM .+ WHERE (.+)', query, re.I)
            if m:
                cols = [c.strip() for c in m.group(1).split(',')]
                cond = m.group(2)
                result = df.query(cond)[cols]
            else:
                return jsonify({'error': 'Invalid query format'}), 400
        else:
            result = df
        return result.to_json(orient='records')
    except Exception as e:
        return jsonify({'error': str(e)}), 500

if __name__ == '__main__':
    app.run(debug=True, port=8080)
