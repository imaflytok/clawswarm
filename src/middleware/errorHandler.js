/**
 * Error Handling Middleware
 */

const notFoundHandler = (req, res, next) => {
  res.status(404).json({
    success: false,
    error: 'Not found',
    path: req.path
  });
};

const errorHandler = (err, req, res, next) => {
  console.error('Error:', err);
  
  res.status(err.status || 500).json({
    success: false,
    error: err.message || 'Internal server error'
  });
};

module.exports = { notFoundHandler, errorHandler };
